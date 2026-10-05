import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
  withCommandProcessScope,
} from "../../process/exec-spawn.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxCleanupEngine,
  DOCKER_SANDBOX_ENGINE,
  execContainerRaw,
  runNativeSandboxCleanup,
} from "./container-engine.js";

const command = vi.hoisted(() => vi.fn());
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: command,
}));
vi.mock("../../infra/executable-path.js", () => ({
  resolveExecutableFromPathEnv: () => process.execPath,
}));

function cleanupEngine() {
  return bindNativeSandboxEngineTarget(captureNativeSandboxCleanupEngine(DOCKER_SANDBOX_ENGINE), {
    key: "unix:///var/run/docker.sock",
    globalArgs: ["--host", "unix:///var/run/docker.sock"],
  });
}

beforeEach(() => command.mockReset());

describe("recorded native allocation cleanup", () => {
  it("refuses ordinary execution through a captured cleanup-only engine", async () => {
    await expect(execContainerRaw(cleanupEngine(), ["start", "a".repeat(64)])).rejects.toThrow(
      "Cleanup-only",
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("uses its captured target outside the revoked producer process scope", async () => {
    const engine = cleanupEngine();
    const controller = new AbortController();
    command.mockImplementation(async (_args, options) => {
      expect(controller.signal.aborted).toBe(true);
      expect(resolveCommandProcessSignal(options.cancelSignal)?.aborted).toBe(false);
      return { failed: false, exitCode: 0, stdout: Buffer.from("137"), stderr: Buffer.alloc(0) };
    });
    const result = await withCommandProcessScope(async () => {
      controller.abort();
      return await runNativeSandboxCleanup(engine, (exec) => exec(["wait", "a".repeat(64)]));
    }, controller.signal);
    expect(result.stdout.toString("utf8")).toBe("137");
    expect(command).toHaveBeenCalledWith(
      [process.execPath, "--host", "unix:///var/run/docker.sock", "wait", "a".repeat(64)],
      expect.objectContaining({ cwd: process.cwd(), encoding: "buffer" }),
    );
  });

  it("joins process cleanup uncertainty before reporting native cleanup success", async () => {
    command.mockImplementation(async () => {
      retainCommandProcessCleanup(Promise.resolve("uncertain"));
      return { failed: false, exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    await expect(
      runNativeSandboxCleanup(cleanupEngine(), (exec) => exec(["rm", "a".repeat(64)])),
    ).rejects.toBeInstanceOf(CommandProcessCleanupError);
  });
});
