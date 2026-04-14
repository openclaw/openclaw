import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted so they are in place when hyprland-capture.ts loads
// and calls promisify(execFile) at the top level.
// ---------------------------------------------------------------------------

const mockExecFile = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockResolveSystemBin = vi.hoisted(() =>
  vi.fn<(name: string, opts?: unknown) => string | null>(),
);

vi.mock("node:child_process", () => {
  // promisify(execFile) is called at the top level of hyprland-capture.ts before
  // any test runs. Without promisify.custom, promisify resolves to a bare string
  // instead of {stdout, stderr}, making JSON.parse(stdout) blow up with undefined.
  const { promisify } = require("node:util") as typeof import("node:util");
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      mockExecFile(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return {
    execFile: mockExecFile,
    execFileSync: mockExecFileSync,
    spawn: mockSpawn,
  };
});

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  resolveSystemBin: mockResolveSystemBin,
}));

// Imports come AFTER vi.mock so mocks are already active.
import {
  _resetHyprlandCaptureForTests,
  captureWithHyprland,
  isHyprlandAvailable,
} from "./hyprland-capture.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;

function makeMonitors(names: string[]): string {
  return JSON.stringify(names.map((name, i) => ({ name, activeWorkspace: { id: 100 + i } })));
}

/** Stub a successful grim capture that writes `pngBytes` to stdout. */
function stubGrimSuccess(pngBytes: Buffer): void {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.kill = () => {};
    // Resolve asynchronously so callers' Promise chains settle normally.
    void Promise.resolve().then(() => {
      child.stdout.emit("data", pngBytes);
      child.emit("close", 0);
    });
    return child;
  });
}

/** Stub grim to fail with exit code 1. */
function stubGrimFail(): void {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.kill = () => {};
    void Promise.resolve().then(() => child.emit("close", 1));
    return child;
  });
}

/** Full successful setup + capture sequence. */
function stubHappyPath(pngBytes: Buffer, outputName = "HEADLESS-1"): void {
  let monitorCount = 0;
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const subArgs = args[1] as string[];
    const cb = args[args.length - 1] as ExecFileCb;
    const key = subArgs[0] ?? "";
    if (key === "monitors") {
      monitorCount++;
      // First call (before create-output): no headless output yet.
      // Subsequent calls: headless output present.
      const names = monitorCount === 1 ? [] : [outputName];
      cb(null, makeMonitors(names), "");
    } else {
      cb(null, "", "");
    }
  });
  stubGrimSuccess(pngBytes);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetHyprlandCaptureForTests();
  process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-sig";
  mockResolveSystemBin.mockImplementation((name: string) => `/usr/bin/${name}`);
});

afterEach(() => {
  delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isHyprlandAvailable", () => {
  it("returns false when HYPRLAND_INSTANCE_SIGNATURE is unset", () => {
    delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
    expect(isHyprlandAvailable()).toBe(false);
  });

  it("returns false when HYPRLAND_INSTANCE_SIGNATURE is blank (whitespace only)", () => {
    process.env.HYPRLAND_INSTANCE_SIGNATURE = "   ";
    expect(isHyprlandAvailable()).toBe(false);
  });

  it("returns true when HYPRLAND_INSTANCE_SIGNATURE is set", () => {
    process.env.HYPRLAND_INSTANCE_SIGNATURE = "abc123";
    expect(isHyprlandAvailable()).toBe(true);
  });
});

describe("captureWithHyprland", () => {
  it("resolves to a Buffer on success", async () => {
    const pngBytes = Buffer.from("\x89PNG\r\n\x1a\n");
    stubHappyPath(pngBytes);

    const result = await captureWithHyprland({ browserPid: 42 });
    expect(result).toEqual(pngBytes);
  });

  it("resets cache to null on execa failure, then throws", async () => {
    // Fail inside setupCapture (create-output succeeds but getActiveWorkspaceId fails).
    let monCount = 0;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const subArgs = args[1] as string[];
      const cb = args[args.length - 1] as ExecFileCb;
      const key = subArgs[0] ?? "";
      if (key === "monitors") {
        monCount++;
        if (monCount <= 2) {
          // before / after create-output — OK
          const names = monCount === 1 ? [] : ["HEADLESS-1"];
          cb(null, makeMonitors(names), "");
        } else {
          // Third call (getActiveWorkspaceId) — fail
          cb(new Error("monitors unavailable"), "", "");
        }
      } else if (key === "create-output") {
        cb(null, "", "");
      } else {
        cb(null, "", "");
      }
    });

    await expect(captureWithHyprland({ browserPid: 1 })).rejects.toThrow();

    // Cache should be null → the next call can retry setup.
    // Verify by running a successful capture immediately after.
    vi.clearAllMocks();
    mockResolveSystemBin.mockImplementation((name: string) => `/usr/bin/${name}`);
    const pngBytes = Buffer.from("PNG-retry");
    stubHappyPath(pngBytes);

    const result = await captureWithHyprland({ browserPid: 1 });
    expect(result).toEqual(pngBytes);
  });

  it("PID change invalidates cached output and calls hyprctl create-output again", async () => {
    // First capture with PID 100.
    const pngA = Buffer.from("png-A");
    stubHappyPath(pngA);

    await captureWithHyprland({ browserPid: 100 });

    // Reconfigure mocks for PID 200 setup.
    vi.clearAllMocks();
    mockResolveSystemBin.mockImplementation((name: string) => `/usr/bin/${name}`);

    let createOutputCalls = 0;
    let monCount = 0;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const subArgs = args[1] as string[];
      const cb = args[args.length - 1] as ExecFileCb;
      const key = subArgs[0] ?? "";
      if (key === "create-output") {
        createOutputCalls++;
        cb(null, "", "");
      } else if (key === "monitors") {
        monCount++;
        const names = monCount === 1 ? [] : ["HEADLESS-2"];
        cb(null, makeMonitors(names), "");
      } else {
        cb(null, "", "");
      }
    });
    const pngB = Buffer.from("png-B");
    stubGrimSuccess(pngB);

    const result = await captureWithHyprland({ browserPid: 200 });
    expect(result).toEqual(pngB);
    expect(createOutputCalls).toBe(1);
  });

  it("process 'exit' handler calls hyprctl output remove to clean up virtual output", async () => {
    const pngBytes = Buffer.from("PNG-cleanup");
    stubHappyPath(pngBytes, "HEADLESS-9");

    await captureWithHyprland({ browserPid: 55 });

    // Trigger the registered exit handler.
    process.emit("exit", 0);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/hyprctl",
      ["output", "remove", "HEADLESS-9"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("resolve-system-bin is called for both grim and hyprctl, not hardcoded paths", async () => {
    // Let setup fail early — we only care about which names resolveSystemBin was called with.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const subArgs = args[1] as string[];
      const cb = args[args.length - 1] as ExecFileCb;
      if (subArgs[0] === "monitors") {
        cb(new Error("fail"), "", "");
      } else {
        cb(null, "", "");
      }
    });

    await captureWithHyprland({ browserPid: 1 }).catch(() => {});

    const names = mockResolveSystemBin.mock.calls.map(([n]) => n);
    expect(names).toContain("hyprctl");
    expect(names).toContain("grim");
  });

  it("grim failure resets cache so next call re-creates the output", async () => {
    // Setup succeeds but grim fails on first capture.
    let monCount = 0;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const subArgs = args[1] as string[];
      const cb = args[args.length - 1] as ExecFileCb;
      const key = subArgs[0] ?? "";
      if (key === "monitors") {
        monCount++;
        cb(null, makeMonitors(monCount === 1 ? [] : ["HEADLESS-1"]), "");
      } else {
        cb(null, "", "");
      }
    });
    stubGrimFail();

    await expect(captureWithHyprland({ browserPid: 7 })).rejects.toThrow();

    // Cache should be null — retry succeeds.
    vi.clearAllMocks();
    mockResolveSystemBin.mockImplementation((name: string) => `/usr/bin/${name}`);
    const pngBytes = Buffer.from("PNG-retry");
    let createCalls = 0;
    monCount = 0;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const subArgs = args[1] as string[];
      const cb = args[args.length - 1] as ExecFileCb;
      const key = subArgs[0] ?? "";
      if (key === "create-output") {
        createCalls++;
        cb(null, "", "");
      } else if (key === "monitors") {
        monCount++;
        cb(null, makeMonitors(monCount === 1 ? [] : ["HEADLESS-1"]), "");
      } else {
        cb(null, "", "");
      }
    });
    stubGrimSuccess(pngBytes);

    const result = await captureWithHyprland({ browserPid: 7 });
    expect(result).toEqual(pngBytes);
    expect(createCalls).toBe(1);
  });

  it("concurrent calls share the in-flight setup promise (setup runs only once)", async () => {
    let createOutputCalls = 0;
    let monCount = 0;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const subArgs = args[1] as string[];
      const cb = args[args.length - 1] as ExecFileCb;
      const key = subArgs[0] ?? "";
      if (key === "create-output") {
        createOutputCalls++;
        cb(null, "", "");
      } else if (key === "monitors") {
        monCount++;
        cb(null, makeMonitors(monCount === 1 ? [] : ["HEADLESS-1"]), "");
      } else {
        cb(null, "", "");
      }
    });
    const pngBytes = Buffer.from("PNG-concurrent");
    stubGrimSuccess(pngBytes);

    const [r1, r2, r3] = await Promise.all([
      captureWithHyprland({ browserPid: 88 }),
      captureWithHyprland({ browserPid: 88 }),
      captureWithHyprland({ browserPid: 88 }),
    ]);

    expect(r1).toEqual(pngBytes);
    expect(r2).toEqual(pngBytes);
    expect(r3).toEqual(pngBytes);
    expect(createOutputCalls).toBe(1);
  });
});
