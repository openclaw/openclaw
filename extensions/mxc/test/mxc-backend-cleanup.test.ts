import { readdirSync } from "node:fs";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, test, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { createMxcSandboxBackendHandle } from "../src/mxc-backend.js";

const { bridgeError } = vi.hoisted(() => ({ bridgeError: new Error("command file write failed") }));

vi.mock("../src/windows-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/windows-command.js")>()),
  createWindowsCommandBridge: () => {
    throw bridgeError;
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

test("cleans the sandbox temp directory when command bridge preparation fails", async () => {
  const tempRoot = tempDirs.make("mxc-bridge-cleanup-");
  vi.stubEnv("TEMP", tempRoot);
  const handle = createMxcSandboxBackendHandle({
    config: resolveConfig(undefined),
    runtimeId: "mxc-cleanup-test",
    workdir: tempRoot,
  });

  await expect(handle.runShellCommand({ script: "echo test", args: ["arg"] })).rejects.toBe(
    bridgeError,
  );
  expect(readdirSync(tempRoot)).toEqual([]);
});
