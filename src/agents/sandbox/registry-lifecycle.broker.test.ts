import { AsyncLocalStorage } from "node:async_hooks";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { executeGitCommand } from "../../infra/git-exec.js";
import { runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../../process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../../process/spawn-broker/pipe.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { execContainerRaw, PODMAN_SANDBOX_ENGINE } from "./container-engine.js";
import {
  acquireSandboxRuntimeUse,
  maybeRunSandboxRegistryHousekeeping,
  prepareSandboxRegistryClose,
  startSandboxRegistryHousekeeping,
} from "./registry-lifecycle.js";
import { useSandboxRegistryState } from "./registry.test-support.js";

const prune = vi.hoisted(() => ({ run: async () => {} }));
// mock-isolation: Prune selection is unrelated; its registered work uses the real process owners below.
vi.mock("./prune.js", () => ({ runSandboxPrune: () => prune.run() }));
const state = useSandboxRegistryState("sandbox-housekeeping-broker-");
const caller = new AsyncLocalStorage<string>();
afterEach(() => vi.useRealTimers());

describe.skipIf(!supportsSpawnBrokerCommandTransport())(
  "sandbox housekeeping spawn ownership",
  () => {
    let broker: SpawnBrokerHost;
    beforeAll(async () => {
      broker = createSpawnBrokerHost();
      await broker.ready();
    });
    afterAll(() => broker.close());

    async function prepareCommands() {
      const source = `#!${process.execPath}
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({parent:process.ppid,args:process.argv.slice(2),env:process.env.HOUSEKEEPING_TEST_VALUE,cwd:process.cwd(),input}));
process.stderr.write('diagnostic\\n');
process.exitCode = 7;
`;
      for (const executable of ["podman", "git"]) {
        await writeFile(path.join(state.root, executable), source, { mode: 0o700 });
      }
      const baseEnv = { PATH: state.root, HOUSEKEEPING_TEST_VALUE: "literal $value" };
      const args = ["inspect", "literal ; $argument"];
      const run = async () => {
        const ambient = caller.getStore();
        const container = await execContainerRaw({ ...PODMAN_SANDBOX_ENGINE, baseEnv }, args, {
          allowFailure: true,
          input: "container input\n",
        });
        const git = await executeGitCommand(state.root, ["status", "--", args[1]!], {
          baseEnv,
          input: "git input\n",
        });
        return { ambient, container, git };
      };
      const check = (result: Awaited<ReturnType<typeof run>>) => {
        expect(result.ambient).toBeUndefined();
        for (const [output, expectedArgs, input] of [
          [result.container, args, "container input\n"],
          [result.git, ["-C", state.root, "status", "--", args[1]], "git input\n"],
        ] as const) {
          expect(JSON.parse(output.stdout.toString())).toEqual({
            parent: broker.pid,
            args: expectedArgs,
            env: "literal $value",
            cwd: process.cwd(),
            input,
          });
          expect(output.stderr.toString()).toBe("diagnostic\n");
          expect(output.code).toBe(7);
        }
      };
      // The registry lifetime can exist before Gateway broker startup.
      const use = await acquireSandboxRuntimeUse({ scopeKey: "preexisting" });
      use[Symbol.dispose]();
      return { run, check };
    }

    it("retains the requesting broker for immediate housekeeping without retaining turn context", async () => {
      const { run, check } = await prepareCommands();
      let result: Awaited<ReturnType<typeof run>> | undefined;
      await caller.run("unrelated-turn", () =>
        runWithSpawnBroker(broker, () =>
          maybeRunSandboxRegistryHousekeeping(async () => {
            result = await run();
          }),
        ),
      );
      expect(result).toBeDefined();
      check(result!);
    });

    it.each(["registration", "gateway close owner"])(
      "retains the registered broker on later timer ticks through %s",
      async (entry) => {
        const { run, check } = await prepareCommands();
        let completed = createDeferredCore<Awaited<ReturnType<typeof run>>>();
        prune.run = async () => {
          try {
            completed.resolve(await run());
          } catch (error) {
            completed.reject(error);
          }
        };
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        const gateway = caller.run("unrelated-turn", () =>
          runWithSpawnBroker(broker, () => {
            if (entry === "registration") {
              startSandboxRegistryHousekeeping(prune.run, completed.reject);
            }
            return prepareSandboxRegistryClose();
          }),
        );
        try {
          check(await completed.promise);
          await maybeRunSandboxRegistryHousekeeping(prune.run);
          completed = createDeferredCore();
          await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
          check(await completed.promise);
        } finally {
          await gateway.drain();
        }
      },
    );
  },
);
