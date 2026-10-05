import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
  withCommandProcessScope,
} from "../../process/exec-spawn.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxCleanupEngine,
  captureNativeSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
  execContainerRaw,
  execNativeSandboxCreate,
  execNativeSandboxStart,
  runNativeSandboxCleanup,
  type NativeSandboxCustody,
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

function fixture() {
  const controller = new AbortController();
  const runtime = new AbortController();
  const custody: NativeSandboxCustody = {
    runtimeKey: "foreground:dispatch",
    runInstance: { runId: "run", instanceId: "instance" },
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    assertCleanupConfirmed() {},
    registerCleanup() {},
    runProducer: (run) => run(),
  };
  const engine = bindNativeSandboxEngineTarget(
    captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody, () =>
      runtime.signal.throwIfAborted(),
    ),
    { key: "unix:///var/run/docker.sock", globalArgs: ["--host", "unix:///var/run/docker.sock"] },
  );
  return { controller, runtime, engine };
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

describe("foreground native dispatch", () => {
  it.each([
    ["create", "Stop"],
    ["start", "Stop"],
    ["create", "workspace retirement"],
    ["start", "workspace retirement"],
  ] as const)(
    "does not dispatch %s after %s during its intent write",
    async (operation, revokedOwner) => {
      const { controller, runtime, engine } = fixture();
      const writing = createDeferred();
      const written = createDeferred();
      const created = vi.fn();
      const notDispatched = vi.fn();
      const intent = async () => {
        writing.resolve();
        await written.promise;
      };
      const pending =
        operation === "create"
          ? execNativeSandboxCreate(
              engine,
              ["create", "sandbox:test"],
              created,
              intent,
              notDispatched,
            )
          : execNativeSandboxStart(engine, "a".repeat(64), intent, notDispatched);
      const stopped = expect(pending).rejects.toThrow();
      await writing.promise;
      (revokedOwner === "Stop" ? controller : runtime).abort();
      written.resolve();
      await stopped;
      expect(command).not.toHaveBeenCalled();
      expect(created).not.toHaveBeenCalled();
      expect(notDispatched).toHaveBeenCalledOnce();
    },
  );

  it("records a late successful full create ID before returning Stop", async () => {
    const { controller, engine } = fixture();
    const dispatched = createDeferred();
    const returned = createDeferred();
    command.mockImplementation(async () => {
      dispatched.resolve();
      await returned.promise;
      return {
        failed: false,
        exitCode: 0,
        stdout: Buffer.from("a".repeat(64)),
        stderr: Buffer.alloc(0),
      };
    });
    const created = vi.fn();
    const notDispatched = vi.fn();
    const pending = execNativeSandboxCreate(
      engine,
      ["create", "sandbox:test"],
      created,
      undefined,
      notDispatched,
    );
    const stopped = expect(pending).rejects.toThrow();
    await dispatched.promise;
    controller.abort();
    returned.resolve();
    await stopped;
    expect(created).toHaveBeenCalledWith("a".repeat(64));
    expect(notDispatched).not.toHaveBeenCalled();
  });
});

it.each([DOCKER_SANDBOX_ENGINE, PODMAN_SANDBOX_ENGINE])(
  "dispatches ordinary $id work without yielding after its caller guard",
  async (engine) => {
    const calls: string[] = [];
    command.mockImplementation(async () => {
      calls.push("spawn");
      return { failed: false, exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const assertCurrent = () => calls.push("assert");
    assertCurrent();
    const pending = execContainerRaw(engine, ["start", "ordinary-container"]);
    expect(calls).toEqual(["assert", "spawn"]);
    await pending;
  },
);
