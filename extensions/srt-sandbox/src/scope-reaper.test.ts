// Tests for the SRT sandbox worker-per-scope reaper (Stage S2).
//
// Proves the design v8 §S2 reaper behavior on the macOS/POSIX path:
//   - the liveness-pipe launcher self-terminates the sandbox process group on
//     parent death (macOS has no PR_SET_PDEATHSIG);
//   - every sandbox command runs in its own process group and is reaped on
//     completion, timeout, abort, and scope teardown — no orphan survives;
//   - buffered commands sweep their own background descendants.
//
// The reaper is sandbox-transport-agnostic (it wraps whatever outer argv it is
// given), so these tests drive it with a plain `[bash, -c, script]` argv to
// isolate the lifecycle mechanism from Seatbelt. The end-to-end proof that the
// mechanism composes with the Seatbelt wrap lives in backend.reaper.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScopeChildReaper,
  ScopeReaperDisposedError,
  wrapWithLivenessLauncher,
} from "./scope-reaper.js";

const isPosix = process.platform !== "win32";

const sleepMs = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone (or fail after `timeoutMs`). */
async function expectDeadWithin(pid: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await sleepMs(50);
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

const bashArgv = (script: string) => ["/bin/bash", "-c", script];

describe.skipIf(!isPosix)("ScopeChildReaper", () => {
  const reapers: ScopeChildReaper[] = [];
  let workdir: string;

  const makeReaper = () => {
    const reaper = new ScopeChildReaper();
    reapers.push(reaper);
    return reaper;
  };

  afterEach(() => {
    while (reapers.length > 0) {
      reapers.pop()?.dispose();
    }
  });

  const run = (reaper: ScopeChildReaper, script: string, timeoutMs = 30_000) => {
    workdir ??= mkdtempSync(path.join(tmpdir(), "srt-reaper-"));
    return reaper.spawn({
      argv: bashArgv(script),
      env: process.env,
      cwd: workdir,
      timeoutMs,
    });
  };

  it("runs a command, buffers stdout, and drains the live registry", async () => {
    const reaper = makeReaper();
    const result = await run(reaper, "printf hi");
    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("hi");
    expect(reaper.liveCount).toBe(0);
  });

  it("preserves a non-zero exit status", async () => {
    const reaper = makeReaper();
    const result = await run(reaper, "exit 7");
    expect(result.code).toBe(7);
    expect(reaper.liveCount).toBe(0);
  });

  it("reaps a background descendant when the command completes", async () => {
    const reaper = makeReaper();
    const dir = mkdtempSync(path.join(tmpdir(), "srt-desc-"));
    const descFile = path.join(dir, "desc.pid");
    // Start a long sleeper in the background and return immediately; without
    // the group sweep on "exit" this descendant would outlive the command.
    await run(reaper, `sleep 120 & echo $! > ${descFile}; exit 0`);
    const descPid = Number(readFileSync(descFile, "utf8").trim());
    expect(Number.isInteger(descPid)).toBe(true);
    await expectDeadWithin(descPid);
    expect(reaper.liveCount).toBe(0);
  });

  it("group-kills an in-flight command (and its descendants) on dispose", async () => {
    const reaper = makeReaper();
    const dir = mkdtempSync(path.join(tmpdir(), "srt-dispose-"));
    const pgidFile = path.join(dir, "pgid");
    const descFile = path.join(dir, "desc.pid");
    const pending = run(reaper, `echo $$ > ${pgidFile}; sleep 120 & echo $! > ${descFile}; wait`);
    // Let the group establish and write its pids.
    while (reaper.liveCount === 0) {
      await sleepMs(20);
    }
    await sleepMs(300);
    const groupLeader = Number(readFileSync(pgidFile, "utf8").trim());
    const descPid = Number(readFileSync(descFile, "utf8").trim());
    expect(isAlive(groupLeader)).toBe(true);

    reaper.dispose();
    await pending.catch(() => {});
    await expectDeadWithin(groupLeader);
    await expectDeadWithin(descPid);
    expect(reaper.liveCount).toBe(0);
  });

  it("group-kills a command that exceeds its timeout", async () => {
    const reaper = makeReaper();
    const dir = mkdtempSync(path.join(tmpdir(), "srt-timeout-"));
    const descFile = path.join(dir, "desc.pid");
    const result = await run(reaper, `sleep 120 & echo $! > ${descFile}; wait`, 250);
    expect(result.code).not.toBe(0);
    const descPid = Number(readFileSync(descFile, "utf8").trim());
    await expectDeadWithin(descPid);
    expect(reaper.liveCount).toBe(0);
  });

  it("aborts an in-flight command via its signal", async () => {
    const reaper = makeReaper();
    const dir = mkdtempSync(path.join(tmpdir(), "srt-abort-"));
    const descFile = path.join(dir, "desc.pid");
    const controller = new AbortController();
    const pending = reaper.spawn({
      argv: bashArgv(`sleep 120 & echo $! > ${descFile}; wait`),
      env: process.env,
      cwd: mkdtempSync(path.join(tmpdir(), "srt-abort-ws-")),
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    while (reaper.liveCount === 0) {
      await sleepMs(20);
    }
    await sleepMs(300);
    const descPid = Number(readFileSync(descFile, "utf8").trim());
    controller.abort();
    await pending.catch(() => {});
    await expectDeadWithin(descPid);
    expect(reaper.liveCount).toBe(0);
  });

  it("rejects commands submitted after dispose", async () => {
    const reaper = makeReaper();
    reaper.dispose();
    await expect(run(reaper, "printf hi")).rejects.toBeInstanceOf(ScopeReaperDisposedError);
  });
});

/** Poll until `file` holds a positive integer pid. */
async function readPidFile(file: string, timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // not written yet
    }
    await sleepMs(20);
  }
  throw new Error(`no pid written to ${file} after ${timeoutMs}ms`);
}

describe.skipIf(!isPosix)("ScopeChildReaper.terminate", () => {
  const reapers: ScopeChildReaper[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (reapers.length > 0) {
      reapers.pop()?.dispose();
    }
  });

  /** A broker-shaped group: leader shell plus one background descendant. */
  async function spawnBrokerGroup() {
    const reaper = new ScopeChildReaper();
    reapers.push(reaper);
    const dir = mkdtempSync(path.join(tmpdir(), "srt-terminate-"));
    const descFile = path.join(dir, "desc.pid");
    const handle = reaper.spawnBroker({
      argv: bashArgv(`sleep 120 & echo $! > ${descFile}; wait`),
      env: process.env,
      cwd: dir,
    });
    const descPid = await readPidFile(descFile);
    return { reaper, child: handle.child, descPid };
  }

  const groupKills = (kill: { mock: { calls: unknown[][] } }) =>
    kill.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0);

  it("kills an owned live group and keeps the numeric kill as fallback", async () => {
    const { reaper, child, descPid } = await spawnBrokerGroup();
    const kill = vi.spyOn(process, "kill");

    reaper.terminate(child);

    expect(groupKills(kill)).toEqual([[-child.pid!, "SIGKILL"]]);
    await expectDeadWithin(child.pid!);
    await expectDeadWithin(descPid);
  });

  // Node records exitCode/signalCode when it reaps the leader, before "exit"
  // listeners run; from then on the numeric pid may be reused by an unrelated
  // process group. Only the in-group liveness watcher may kill in that window.
  it.each([
    ["exit already recorded (pid-reuse window)", { exitCode: 0 }],
    ["signal already recorded", { signalCode: "SIGKILL" }],
    ["child already killed", { killed: true }],
  ])("never group-kills by pid once %s; liveness custody still reaps", async (_label, state) => {
    const { reaper, child, descPid } = await spawnBrokerGroup();
    const leaderPid = child.pid!;
    // Simulate the reaped-but-not-yet-dispatched leader on the real child.
    Object.assign(child, state);
    const kill = vi.spyOn(process, "kill");

    reaper.terminate(child);

    expect(groupKills(kill)).toEqual([]);
    await expectDeadWithin(descPid);
    await expectDeadWithin(leaderPid);
  });

  it("never signals a child it does not track", async () => {
    const reaper = new ScopeChildReaper();
    reapers.push(reaper);
    const foreign: ChildProcess = spawn("/bin/sleep", ["120"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      const kill = vi.spyOn(process, "kill");
      reaper.terminate(foreign);
      reaper.dispose();
      expect(kill).not.toHaveBeenCalled();
      expect(isAlive(foreign.pid!)).toBe(true);
    } finally {
      vi.restoreAllMocks();
      foreign.kill("SIGKILL");
    }
  });
});

describe.skipIf(!isPosix)("liveness-pipe launcher on parent death", () => {
  it("SIGKILLs the sandbox process group when the liveness fd reaches EOF", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "srt-liveness-"));
    const descFile = path.join(dir, "desc.pid");
    // Spawn exactly as ScopeChildReaper does: detached (own group) with the
    // liveness read end on fd 3, whose write end we hold via child.stdio[3].
    const child = spawn(
      "/bin/bash",
      ["-c", wrapWithLivenessLauncher(`sleep 120 & echo $! > ${descFile}; wait`)],
      { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );
    child.stdio[3]?.on("error", () => {});
    // Wait for the descendant to exist.
    const deadline = Date.now() + 4000;
    let descPid = Number.NaN;
    while (Date.now() < deadline) {
      try {
        descPid = Number(readFileSync(descFile, "utf8").trim());
        if (Number.isInteger(descPid) && descPid > 0) {
          break;
        }
      } catch {
        // not written yet
      }
      await sleepMs(50);
    }
    expect(isAlive(descPid)).toBe(true);

    // Simulate parent death: closing the only write end drives fd 3 to EOF.
    child.stdio[3]?.destroy();

    await expectDeadWithin(descPid);
  });
});
