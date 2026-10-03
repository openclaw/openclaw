import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { OwnedStdioCleanupError } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexComputerUseProbeService } from "./computer-use-probe-service.js";

const fake = vi.hoisted(() => ({ spawn: vi.fn(), close: vi.fn(), exec: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  createOwnedStdioProcess: fake.spawn,
  closeOwnedStdioProcess: fake.close,
  runExec: fake.exec,
}));

describe.runIf(process.platform !== "win32")("private native candidate service", () => {
  const sockets: net.Server[] = [];
  const roots = new Set<string>();
  let controller: AbortController;
  const params = () => ({
    appPath: "/private/fixture/Codex Computer Use.app",
    home: "/private/fixture/probe-home",
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  });
  const adapter = () => ({
    onExit: vi.fn(),
    onError: vi.fn(),
    onStdout: vi.fn(),
    onStderr: vi.fn(),
  });
  beforeEach(() => {
    vi.resetAllMocks();
    controller = new AbortController();
    fake.exec.mockResolvedValue({ stdout: "Codex Computer Use\n", stderr: "" });
    fake.spawn.mockImplementation(async ({ env }) => {
      roots.add(path.dirname(env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH));
      const socket = net.createServer((client) => client.end());
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH, resolve);
      });
      return adapter();
    });
    fake.close.mockImplementation(async () => {
      await Promise.all(
        sockets
          .filter((s) => s.listening)
          .map(
            (s) =>
              new Promise<void>((resolve, reject) => {
                s.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
      );
    });
  });
  afterEach(async () => {
    try {
      await Promise.all(
        sockets
          .splice(0)
          .filter((s) => s.listening)
          .map(
            (s) =>
              new Promise<void>((resolve, reject) => {
                s.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
      );
      await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })));
    } finally {
      roots.clear();
      vi.unstubAllEnvs();
    }
  });

  it("routes the SDK to a short private socket and retains IPC until its process owner settles", async () => {
    vi.stubEnv("EXAMPLE_API_KEY", "not-a-real-credential");
    const service = await startCodexComputerUseProbeService(params());
    const pipe = service.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH;
    expect(Buffer.byteLength(pipe)).toBeLessThan(104);
    expect((await fs.stat(pipe)).isSocket()).toBe(true);
    expect((await fs.stat(path.dirname(pipe))).mode & 0o777).toBe(0o700);
    const launch = fake.spawn.mock.calls[0]?.[0];
    if (!launch) {
      throw new Error("Expected the native service launch to be recorded");
    }
    expect(launch.env.HOME).toBe(params().home);
    expect(launch.env.CODEX_HOME).toBe(params().home);
    expect(launch.env.EXAMPLE_API_KEY).toBeUndefined();
    expect(launch.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH).toBe(pipe);
    // The SDK's supported host-service route cannot launch a detached GUI app.
    expect(path.dirname(service.env.NODE_REPL_HOST_SERVICES_PIPE_PATH)).toBe(path.dirname(pipe));
    await expect(fs.stat(service.env.NODE_REPL_HOST_SERVICES_PIPE_PATH)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const originalClose = fake.close.getMockImplementation()!;
    let settle!: () => void;
    fake.close.mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      await originalClose(...args);
    });
    const closing = service.close();
    try {
      await expect(fs.stat(pipe)).resolves.toBeDefined();
    } finally {
      settle();
      await closing;
    }
    await service.close();
    expect(fake.close).toHaveBeenCalledOnce();
    await expect(fs.stat(path.dirname(pipe))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["revoked", "exited"])(
    "settles failed startup when the service is %s",
    async (failure) => {
      fake.spawn.mockImplementation(async ({ env }) => {
        roots.add(path.dirname(env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH));
        const child = adapter();
        if (failure === "revoked") {
          controller.abort(new Error("owner revoked"));
        } else {
          child.onExit.mockImplementation((callback) => callback(2, null));
        }
        return child;
      });
      await expect(startCodexComputerUseProbeService(params())).rejects.toThrow(
        failure === "revoked" ? "owner revoked" : "service exited",
      );
      expect(fake.close).toHaveBeenCalledOnce();
      for (const root of roots) {
        await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("retains IPC when the spawn owner cannot settle a failed launch", async () => {
    fake.spawn.mockImplementation(async ({ env }) => {
      roots.add(path.dirname(env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH));
      throw new OwnedStdioCleanupError("startup tree unsettled");
    });
    await expect(startCodexComputerUseProbeService(params())).rejects.toMatchObject({
      code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
    });
    expect(fake.close).not.toHaveBeenCalled();
    expect(roots.size).toBe(1);
    for (const root of roots) {
      await expect(fs.stat(root)).resolves.toBeDefined();
    }
    // Only the fake retained directory is removed by afterEach.
  });

  it("preserves private IPC when process-tree cleanup cannot be certified", async () => {
    const service = await startCodexComputerUseProbeService(params());
    fake.close.mockRejectedValue(new Error("extinction uncertain"));
    await expect(service.close()).rejects.toMatchObject({
      code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
    });
    await expect(fs.stat(service.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH)).resolves.toBeDefined();
    // afterEach owns the fake socket; no native child was started.
  });
});
