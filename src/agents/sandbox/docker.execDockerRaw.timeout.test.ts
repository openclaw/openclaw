// Regression for the sandbox-init hang (#90980): a wedged Docker engine (child
// emits nothing, never closes) must reject via the execDockerRaw deadline, not
// pend forever (existing docker tests only cover the ENOENT path). Mock-based;
// Windows-safe — the mock drives behavior via hoisted state and ignores the
// resolved command path.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockDockerChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: (input?: string | Buffer) => void };
  kill: (signal?: NodeJS.Signals) => boolean;
};

const spawnState = vi.hoisted(() => ({
  behavior: "hang" as "hang" | "close" | "closeOnKill",
  exitCode: 0,
  killSignals: [] as (NodeJS.Signals | undefined)[],
}));

function createMockDockerChild(): MockDockerChild {
  const child = new EventEmitter() as MockDockerChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end: () => undefined };
  child.kill = (signal?: NodeJS.Signals) => {
    spawnState.killSignals.push(signal);
    if (spawnState.behavior === "closeOnKill") {
      // Simulate a killable child: SIGTERM terminates it, so `close` fires.
      queueMicrotask(() => child.emit("close", null));
    }
    return true;
  };
  return child;
}

function spawnMockDockerProcess() {
  // Ignore command/args: on Windows the command is the resolved docker.exe path.
  const child = createMockDockerChild();
  if (spawnState.behavior === "close") {
    queueMicrotask(() => child.emit("close", spawnState.exitCode));
  }
  // "hang"/"closeOnKill": never emit `close` on its own. For "hang" the deadline
  // is the only thing that can settle the promise (the wedged-engine case).
  return child;
}

async function createChildProcessMock() {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMockDockerProcess };
}

vi.mock("node:child_process", async () => createChildProcessMock());

let execDockerRaw: typeof import("./docker.js").execDockerRaw;
let isDockerExecTimeoutError: typeof import("./docker.js").isDockerExecTimeoutError;

async function loadFreshDockerModule() {
  vi.resetModules();
  vi.doMock("node:child_process", async () => createChildProcessMock());
  ({ execDockerRaw, isDockerExecTimeoutError } = await import("./docker.js"));
}

describe("execDockerRaw deadline", () => {
  beforeEach(async () => {
    spawnState.behavior = "hang";
    spawnState.exitCode = 0;
    spawnState.killSignals.length = 0;
    await loadFreshDockerModule();
  });

  it("rejects via the deadline when Docker is present but unresponsive", async () => {
    // Wedged engine: the child never emits data, error, or close. Without a
    // deadline this promise would pend forever — the still-open hang of #5135.
    spawnState.behavior = "hang";

    let caught: unknown;
    try {
      await execDockerRaw(["version"], { timeoutMs: 25 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(isDockerExecTimeoutError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe("SANDBOX_DOCKER_TIMEOUT");
    expect((caught as { timeoutMs?: number }).timeoutMs).toBe(25);
    // The wedged child must be killed on timeout, not leaked.
    expect(spawnState.killSignals).toContain("SIGTERM");
  });

  it("resolves on the success path before the deadline (unchanged behavior)", async () => {
    spawnState.behavior = "close";
    spawnState.exitCode = 0;

    await expect(execDockerRaw(["version"], { timeoutMs: 5_000 })).resolves.toMatchObject({
      code: 0,
    });
    expect(spawnState.killSignals).toHaveLength(0);
  });

  it("lets a caller abort win over the deadline (AbortError, not a timeout error)", async () => {
    // First-to-fire-wins: the abort settles the promise; the deadline must not
    // also reject (no double-settle) and must be cleared.
    spawnState.behavior = "closeOnKill";

    let caught: unknown;
    try {
      await execDockerRaw(["version"], { signal: AbortSignal.abort(), timeoutMs: 5_000 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
    expect(isDockerExecTimeoutError(caught)).toBe(false);
    expect(spawnState.killSignals).toContain("SIGTERM");
  });

  it("does not arm a deadline when timeoutMs is omitted (back-compat, no spurious kill)", async () => {
    spawnState.behavior = "close";

    await expect(execDockerRaw(["version"]).then((result) => result.code)).resolves.toBe(0);
    expect(spawnState.killSignals).toHaveLength(0);
  });
});
