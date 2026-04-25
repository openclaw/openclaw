import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { execFile: vi.fn() },
  );
});

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("../../../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    { existsSync: vi.fn().mockReturnValue(true), accessSync: vi.fn() },
    { mirrorToDefault: true },
  );
});

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { _resetCaptureState, tryHyprlandViewportCapture } from "./hyprland-capture.js";

const mockExecFile = vi.mocked(execFile);

type ExecFileCallback = (
  err: NodeJS.ErrnoException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

function stubExecFile(impl: (cmd: string, args: string[], cb: ExecFileCallback) => void): void {
  mockExecFile.mockImplementation((cmd, args, _opts, cb) => {
    impl(String(cmd), Array.isArray(args) ? args.map(String) : [], cb as ExecFileCallback);
    return {} as ReturnType<typeof execFile>;
  });
}

const FAKE_INSTANCE = {
  instance: "abc123",
  wl_socket: "wayland-1",
  time: 1000,
};

const FAKE_MONITOR = {
  name: "browser-capture",
  width: 1920,
  height: 1080,
  refreshRate: 60,
  x: 0,
  y: 0,
  scale: 1,
  activeWorkspace: { id: 10, name: "10" },
};

const FAKE_CLIENT = {
  pid: 42,
  workspace: { id: 10, name: "10" },
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeHappyPathExecFile(): void {
  stubExecFile((_cmd, args, cb) => {
    if (args.includes("instances")) return cb(null, JSON.stringify([FAKE_INSTANCE]), "");
    if (args.includes("monitors")) return cb(null, JSON.stringify([FAKE_MONITOR]), "");
    if (args.includes("clients")) return cb(null, JSON.stringify([FAKE_CLIENT]), "");
    if (args.includes("movetoworkspacesilent") || args.includes("output"))
      return cb(null, "ok", "");
    return cb(null, PNG_BYTES, Buffer.alloc(0));
  });
}

const originalPlatform = process.platform;

beforeEach(() => {
  _resetCaptureState();
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.accessSync).mockReturnValue(undefined);
});

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  vi.resetAllMocks();
  _resetCaptureState();
});

describe("tryHyprlandViewportCapture — platform guard", () => {
  it("returns null on non-Linux without calling execFile", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const result = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(result).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("proceeds on Linux", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    makeHappyPathExecFile();
    const result = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(result).toBeInstanceOf(Buffer);
    expect(result?.slice(0, 4).toString("hex")).toBe("89504e47");
  });
});

describe("tryHyprlandViewportCapture — session detection", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  });

  it("returns null when hyprctl binary is not found", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(result).toBeNull();
  });

  it("returns null when hyprctl instances call fails", async () => {
    stubExecFile((_cmd, _args, cb) => cb(new Error("hyprctl not running"), "", ""));
    const result = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(result).toBeNull();
  });

  it("returns null when no Hyprland instances are running", async () => {
    stubExecFile((_cmd, args, cb) => {
      if (args.includes("instances")) return cb(null, "[]", "");
      cb(new Error("unexpected call"), "", "");
    });
    const result = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(result).toBeNull();
  });

  it("returns null when socket file does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    stubExecFile((_cmd, args, cb) => {
      if (args.includes("instances")) return cb(null, JSON.stringify([FAKE_INSTANCE]), "");
      cb(new Error("unexpected call"), "", "");
    });
    const result = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(result).toBeNull();
  });
});

describe("tryHyprlandViewportCapture — cache and lifecycle", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  });

  it("returns null and clears cache when setup throws", async () => {
    stubExecFile((_cmd, args, cb) => {
      if (args.includes("instances")) return cb(null, JSON.stringify([FAKE_INSTANCE]), "");
      cb(new Error("hyprctl monitors failed"), "", "");
    });
    const result = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(result).toBeNull();

    const result2 = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(result2).toBeNull();
    expect(mockExecFile).toHaveBeenCalledTimes(4);
  });

  it("returns PNG bytes on success and caches the capture", async () => {
    makeHappyPathExecFile();
    const first = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(first).toBeInstanceOf(Buffer);

    const setupCallCount = mockExecFile.mock.calls.length;
    const second = await tryHyprlandViewportCapture({ browserPid: 42 });
    expect(second).toBeInstanceOf(Buffer);
    expect(mockExecFile.mock.calls.length - setupCallCount).toBeLessThan(4);
  });

  it("tears down old capture and sets up new when PID changes", async () => {
    makeHappyPathExecFile();
    await tryHyprlandViewportCapture({ browserPid: 42 });

    const callsBefore = mockExecFile.mock.calls.length;
    makeHappyPathExecFile();
    await tryHyprlandViewportCapture({ browserPid: 99 });

    const removeCalls = mockExecFile.mock.calls
      .slice(callsBefore)
      .filter(([, args]) => Array.isArray(args) && args.includes("remove"));
    expect(removeCalls.length).toBeGreaterThan(0);
  });
});

describe("tryHyprlandViewportCapture — concurrent calls", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  });

  it("only performs setup once when called concurrently", async () => {
    let instanceCallCount = 0;
    stubExecFile((_cmd, args, cb) => {
      if (args.includes("instances")) {
        instanceCallCount++;
        return cb(null, JSON.stringify([FAKE_INSTANCE]), "");
      }
      if (args.includes("monitors")) return cb(null, JSON.stringify([FAKE_MONITOR]), "");
      if (args.includes("clients")) return cb(null, JSON.stringify([FAKE_CLIENT]), "");
      if (args.includes("movetoworkspacesilent") || args.includes("output"))
        return cb(null, "ok", "");
      return cb(null, PNG_BYTES, Buffer.alloc(0));
    });

    const [a, b, c] = await Promise.all([
      tryHyprlandViewportCapture({ browserPid: 42 }),
      tryHyprlandViewportCapture({ browserPid: 42 }),
      tryHyprlandViewportCapture({ browserPid: 42 }),
    ]);

    expect([a, b, c].filter(Boolean)).toHaveLength(3);
    expect(instanceCallCount).toBe(1);
  });
});

describe("_resetCaptureState", () => {
  it("clears cached capture so next call re-runs setup", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    makeHappyPathExecFile();
    await tryHyprlandViewportCapture({ browserPid: 42 });

    const callsAfterFirst = mockExecFile.mock.calls.length;
    _resetCaptureState();

    makeHappyPathExecFile();
    await tryHyprlandViewportCapture({ browserPid: 42 });

    expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
