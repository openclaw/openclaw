import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecFixture } from "./bash-tools.exec-fixture.test-support.js";
import { acquireSandboxGatewayOwner } from "./sandbox/registry.test-support.js";
import { captureSandboxStateOwner } from "./sandbox/state-owner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetProcessRegistryForTests();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32")(
  "refuses the real sandbox process when its state alias changes during approval",
  async () => {
    const first = tempDirs.make("sandbox-launch-first-");
    const second = tempDirs.make("sandbox-launch-second-");
    const alias = path.join(tempDirs.make("sandbox-launch-selection-"), "selected");
    const marker = path.join(first, "effect");
    await fs.symlink(first, alias, "dir");
    vi.stubEnv("OPENCLAW_STATE_DIR", alias);
    using owner = acquireSandboxGatewayOwner(first);
    const captured = await captureSandboxStateOwner();
    const finalized: string[] = [];
    const sandbox = {
      containerName: "synthetic-sandbox",
      workspaceDir: first,
      containerWorkdir: first,
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], "created")',
          marker,
        ],
        env: process.env,
        cwd: first,
        stdinMode: "pipe-closed" as const,
        assertCurrent: captured.assertCurrent,
        prepareCurrent: captured.prepareCurrent,
      }),
      finalizeExec: async ({ status }: { status: "completed" | "failed" }) => {
        finalized.push(status);
      },
    };
    const starting = runExecFixture({
      workdir: first,
      sandbox,
      beforeSpawn: async () => {
        await fs.unlink(alias);
        await fs.symlink(second, alias, "dir");
        owner.assertCurrent();
      },
    });
    // Join a wrongly admitted child as well, so the negative control owns its effect.
    await expect(starting.then((run) => run.promise)).rejects.toMatchObject({
      code: "GATEWAY_STATE_OWNER_REQUIRED",
    });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(finalized).toEqual(["failed"]);
    await fs.unlink(alias);
    await fs.symlink(first, alias, "dir");
    const run = await runExecFixture({ workdir: first, sandbox });
    expect(await run.promise).toMatchObject({ status: "completed", exitCode: 0 });
    expect(await fs.readFile(marker, "utf8")).toBe("created");
    expect(finalized).toEqual(["failed", "completed"]);
  },
);
