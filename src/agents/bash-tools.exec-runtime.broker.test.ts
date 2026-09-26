import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const tracked = { ...actual };
  vi.spyOn(tracked, "spawn");
  return mockNodeBuiltinModule(() => Promise.resolve(actual), { spawn: tracked.spawn });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetProcessRegistryForTests();
});

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "exec tool broker transport",
  () => {
    it("keeps detached scheduled exec on its Gateway broker", async () => {
      const home = tempDirs.make("openclaw-scheduled-exec-broker-");
      vi.stubEnv("HOME", home);
      vi.stubEnv("SHELL", "/bin/bash");
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
      vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
      const broker = createSpawnBrokerHost();
      let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
      try {
        await broker.ready();
        vi.mocked(spawn).mockClear();
        const runScheduled = runWithSpawnBroker(broker, () => createScheduledGatewayRunner());
        const outcome = await runInDetachedAsyncContext(() =>
          runScheduled(async () => {
            const command = 'printf "%s" "$PPID"';
            run = await runExecProcess({
              command,
              execCommand: command,
              workdir: home,
              env: { HOME: home, PATH: "/usr/bin:/bin" },
              usePty: false,
              warnings: [],
              maxOutput: 1000,
              pendingMaxOutput: 1000,
              notifyOnExit: false,
              timeoutSec: 10,
            });
            return await run.promise;
          }),
        );
        expect(outcome).toMatchObject({ status: "completed", exitCode: 0 });
        expect(Number(outcome.aggregated)).toBe(broker.pid);
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        try {
          run?.kill();
          await run?.promise;
        } finally {
          await broker.close();
        }
      }
    });

    it("captures and validates shell startup state without forking the Gateway", async () => {
      const home = tempDirs.make("openclaw-exec-broker-");
      vi.stubEnv("HOME", home);
      vi.stubEnv("SHELL", "/bin/bash");
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
      vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "1");
      await fs.writeFile(
        path.join(home, ".bashrc"),
        'printf "%s" "$PPID" > "$HOME/capture-parent"\noc_broker_fn() { printf snapshot-ok; }\n',
      );
      const broker = createSpawnBrokerHost();
      await broker.ready();
      const nativeSpawn = vi.mocked(spawn);
      nativeSpawn.mockClear();
      const brokerSpawn = vi.spyOn(broker, "spawn");
      const scopeKey = `exec-broker:${home}`;
      const closeScope = getProcessSupervisor().acquireScopeCleanup(scopeKey, {
        processTree: "owned-only",
      });
      try {
        const outcome = await runWithSpawnBroker(broker, async () => {
          const run = await runExecProcess({
            command: 'oc_broker_fn; printf ":%s:%s" "$PWD" "$OPENCLAW_SHELL"',
            workdir: home,
            env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
            usePty: false,
            warnings: [],
            maxOutput: 1000,
            pendingMaxOutput: 1000,
            notifyOnExit: false,
            timeoutSec: 10,
            scopeKey,
          });
          return await run.promise;
        });
        expect(outcome).toMatchObject({
          status: "completed",
          exitCode: 0,
          aggregated: `snapshot-ok:${home}:exec`,
        });
        expect(Number(await fs.readFile(path.join(home, "capture-parent"), "utf8"))).toBe(
          broker.pid,
        );
        // Capture and validation both precede the supervised command's relay.
        expect(brokerSpawn.mock.calls.filter(([command]) => command === "/bin/bash")).toHaveLength(
          2,
        );
        expect(nativeSpawn).not.toHaveBeenCalled();
      } finally {
        await closeScope();
        await broker.close();
      }
    });
  },
);
