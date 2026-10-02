import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  execNativeSandboxCreate,
  execNativeSandboxStart,
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

function fixture() {
  const controller = new AbortController();
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
    captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody),
    { key: "unix:///var/run/docker.sock", globalArgs: ["--host", "unix:///var/run/docker.sock"] },
  );
  return { controller, engine };
}

beforeEach(() => command.mockReset());

describe("foreground native dispatch", () => {
  it.each(["create", "start"] as const)(
    "does not dispatch %s after Stop during its intent write",
    async (operation) => {
      const { controller, engine } = fixture();
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
      controller.abort();
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
