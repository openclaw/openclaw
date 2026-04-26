import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BootGuardError,
  nextBackoff,
  runSupervisor,
  stopSupervisor,
  validateBootGuard,
  writeIntent,
  writePid,
} from "../src/supervisor.js";

let tmpHome: string;
let prevHome: string | undefined;
let prevDashboardPath: string | undefined;
let mcRoot: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "dashboard-launcher-supervisor-"));
  prevHome = process.env.HOME;
  prevDashboardPath = process.env.OPENCLAW_DASHBOARD_PATH;
  process.env.HOME = tmpHome;
  mcRoot = join(tmpHome, "mc");
  mkdirSync(mcRoot, { recursive: true });
  writeFileSync(join(mcRoot, "server.js"), "// stub");
  process.env.OPENCLAW_DASHBOARD_PATH = mcRoot;
});

afterEach(() => {
  process.env.HOME = prevHome;
  if (prevDashboardPath === undefined) {
    delete process.env.OPENCLAW_DASHBOARD_PATH;
  } else {
    process.env.OPENCLAW_DASHBOARD_PATH = prevDashboardPath;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("validateBootGuard", () => {
  test("passes when public mode off", () => {
    expect(() => validateBootGuard({ port: 3001, publicMode: false })).not.toThrow();
  });

  test("passes with a 32+ hex token in public mode", () => {
    const token = "a".repeat(32);
    expect(() =>
      validateBootGuard({ port: 3001, publicMode: true, authToken: token }),
    ).not.toThrow();
  });

  test("throws when public mode is on but token is missing", () => {
    expect(() => validateBootGuard({ port: 3001, publicMode: true })).toThrow(BootGuardError);
  });

  test("throws when public mode is on but token is too short", () => {
    expect(() => validateBootGuard({ port: 3001, publicMode: true, authToken: "abcd" })).toThrow(
      BootGuardError,
    );
  });

  test("throws when token is long enough but contains non-hex characters", () => {
    expect(() =>
      validateBootGuard({ port: 3001, publicMode: true, authToken: "z".repeat(40) }),
    ).toThrow(BootGuardError);
  });
});

describe("nextBackoff", () => {
  test("first crash → 1s", () => {
    const { delaySeconds } = nextBackoff({ consecutiveCrashes: 0, lastUptimeMs: 0 });
    expect(delaySeconds).toBe(1);
  });

  test("walks 1, 2, 4, 8, 60 ladder", () => {
    let state = { consecutiveCrashes: 0, lastUptimeMs: 0 };
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const result = nextBackoff(state);
      seen.push(result.delaySeconds);
      state = result.nextState;
    }
    expect(seen).toEqual([1, 2, 4, 8, 60, 60]);
  });

  test("clean uptime ≥5m resets to 1s", () => {
    const { delaySeconds, nextState } = nextBackoff({
      consecutiveCrashes: 4,
      lastUptimeMs: 6 * 60 * 1000,
    });
    expect(delaySeconds).toBe(1);
    expect(nextState.consecutiveCrashes).toBe(1);
  });
});

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
}

describe("runSupervisor loop", () => {
  test("exits when intent flips to stopped", async () => {
    const intents = ["running", "stopped"];
    const intentReader = () => (intents.shift() ?? "stopped") as "running" | "stopped";
    const child = new FakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });

    await runSupervisor({
      env: { port: 3001, publicMode: false },
      cwd: mcRoot,
      deps: {
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
        intentReader,
        sleep: () => Promise.resolve(),
        now: () => 0,
      },
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  test("respects backoff between crashes", async () => {
    let crashes = 0;
    const intentReader = (): "running" | "stopped" => (crashes >= 2 ? "stopped" : "running");
    const spawnFn = vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => {
        crashes += 1;
        child.emit("exit", 1, null);
      });
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });
    const sleep = vi.fn(() => Promise.resolve());

    await runSupervisor({
      env: { port: 3001, publicMode: false },
      cwd: mcRoot,
      deps: {
        spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
        intentReader,
        sleep,
        now: () => 0,
      },
    });

    expect(spawnFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  test("rethrows BootGuardError when MISSION_CONTROL_PUBLIC=1 and token is missing", async () => {
    await expect(
      runSupervisor({
        env: { port: 3001, publicMode: true },
        cwd: mcRoot,
      }),
    ).rejects.toBeInstanceOf(BootGuardError);
  });
});

describe("stopSupervisor", () => {
  test("flips intent to stopped and returns when no pid file present", async () => {
    const result = await stopSupervisor({});
    expect(result.stopped).toBe(true);
    expect(result.pid).toBeNull();
  });

  test("SIGTERMs the recorded pid and returns once the process is gone", async () => {
    writeIntent("running");
    writePid(99999);
    let alive = true;
    const signals: Array<[number, NodeJS.Signals | 0]> = [];

    const result = await stopSupervisor({
      termGraceMs: 1000,
      signal: (pid, sig) => {
        signals.push([pid, sig]);
        if (sig === "SIGTERM") {
          alive = false;
        }
      },
      alive: () => alive,
      sleep: () => Promise.resolve(),
    });

    expect(signals[0]).toEqual([99999, "SIGTERM"]);
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(99999);
  });

  test("escalates to SIGKILL when SIGTERM does not stop the process", async () => {
    writeIntent("running");
    writePid(88888);
    const signals: Array<NodeJS.Signals | 0> = [];

    await stopSupervisor({
      termGraceMs: 50,
      signal: (_pid, sig) => signals.push(sig),
      alive: () => true,
      sleep: () => Promise.resolve(),
    });

    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });
});
