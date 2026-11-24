import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { writeFakeContainerExecutable } from "./container-engine.scope.test-support.js";
import { retireSandboxDependencyTemplate } from "./dependency-template.js";
import { readRegistry, updateRegistry } from "./registry.js";
import { acquireSandboxGatewayOwner, useSandboxRegistryState } from "./registry.test-support.js";
import { prepareSandboxStateOwnerPath } from "./state-owner-path.js";

const fixture = useSandboxRegistryState("openclaw-template-custody-");

it.skipIf(process.platform === "win32")(
  "refuses builder retirement after custody is released during physical preparation",
  async ({ signal }) => {
    const directory = fixture.root;
    const marker = path.join(directory, "effect");
    writeFakeContainerExecutable(
      directory,
      "docker",
      `const args = process.argv.slice(2);
if (args[0] === "kill") require("node:fs").writeFileSync(${JSON.stringify(marker)}, "killed");
process.stdout.write(args.includes("{{json .State}}")
  ? JSON.stringify({ Running: false, Paused: false, Pid: 0 })
  : "a".repeat(64));`,
    );
    vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
    using lease = acquireSandboxGatewayOwner(directory);
    await updateRegistry({
      containerName: "builder",
      backendId: "docker",
      sessionKey: "worktree-dependencies:fixture",
      workspaceDir: directory,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "fixture",
    });
    const databasePath = resolveOpenClawStateSqlitePath();
    const stateOwnerPath = {
      path: databasePath,
      canonicalPath: await fs.realpath(databasePath),
    };
    const gate = createEnteredGate();
    const run = (current: typeof lease, stallPreparation = false) =>
      retireSandboxDependencyTemplate(directory, current.assertCurrent, undefined, {
        assertHost: current.assertCurrent,
        stateOwnerPath,
        prepareHost: async () => {
          if (!stallPreparation) {
            return await prepareSandboxStateOwnerPath(stateOwnerPath);
          }
          const realpath = fs.realpath;
          const lookup = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
            await gate.wait();
            return realpath(...args);
          });
          try {
            await prepareSandboxStateOwnerPath(stateOwnerPath);
          } finally {
            lookup.mockRestore();
          }
        },
      });
    const operation = run(lease, true);
    try {
      await withinTest(
        awaitGateBeforeSettlement(gate.entered, operation, "builder physical preparation"),
        signal,
      );
      lease.release();
    } finally {
      gate.release();
    }
    await expect(operation).rejects.toThrow();
    await expect(fs.readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    using successor = acquireSandboxGatewayOwner(directory);
    expect((await readRegistry()).entries[0]?.runtimeState).toBe("removing");
    await run(successor);
    expect(await fs.readFile(marker, "utf8")).toBe("killed");
  },
);
