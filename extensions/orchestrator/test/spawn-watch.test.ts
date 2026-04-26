import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findSpawnOutcome, watchForSpawnOutcome } from "../src/spawn-watch.js";

let tmpRoot: string;
let sessionFile: string;

function append(line: string): void {
  const existing = (() => {
    try {
      return require("node:fs").readFileSync(sessionFile, "utf8") as string;
    } catch {
      return "";
    }
  })();
  writeFileSync(sessionFile, `${existing}${line}\n`);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orchestrator-spawnwatch-"));
  mkdirSync(join(tmpRoot, "sessions"), { recursive: true });
  sessionFile = join(tmpRoot, "sessions", "agent.jsonl");
  writeFileSync(sessionFile, "");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("findSpawnOutcome", () => {
  test("matches subagent_done for the right parentTaskId", () => {
    append(
      JSON.stringify({
        type: "subagent_done",
        data: { parentTaskId: "T1", result: { text: "ok" } },
      }),
    );
    const outcome = findSpawnOutcome(sessionFile, "T1");
    expect(outcome?.kind).toBe("done");
  });

  test("ignores events for different parentTaskId", () => {
    append(
      JSON.stringify({
        type: "subagent_done",
        data: { parentTaskId: "OTHER" },
      }),
    );
    expect(findSpawnOutcome(sessionFile, "T1")).toBeNull();
  });

  test("matches subagent_failed and surfaces the reason", () => {
    append(
      JSON.stringify({
        type: "subagent_failed",
        data: { parentTaskId: "T1", reason: "specialist_aborted" },
      }),
    );
    const outcome = findSpawnOutcome(sessionFile, "T1");
    expect(outcome?.kind).toBe("failed");
    expect(outcome && outcome.kind === "failed" && outcome.reason).toBe("specialist_aborted");
  });

  test("matches the dotted variant (subagent.done)", () => {
    append(JSON.stringify({ type: "subagent.done", data: { parentTaskId: "T1" } }));
    expect(findSpawnOutcome(sessionFile, "T1")?.kind).toBe("done");
  });

  test("matches sessions.spawn.complete", () => {
    append(
      JSON.stringify({
        type: "sessions.spawn.complete",
        data: { parentTaskId: "T1" },
      }),
    );
    expect(findSpawnOutcome(sessionFile, "T1")?.kind).toBe("done");
  });

  test("returns null on a missing file", () => {
    expect(findSpawnOutcome(`${sessionFile}.missing`, "T1")).toBeNull();
  });

  test("skips malformed JSON lines without throwing", () => {
    writeFileSync(
      sessionFile,
      [
        "{ this is not json",
        JSON.stringify({
          type: "subagent_done",
          data: { parentTaskId: "T1" },
        }),
        "",
      ].join("\n"),
    );
    expect(findSpawnOutcome(sessionFile, "T1")?.kind).toBe("done");
  });
});

describe("watchForSpawnOutcome", () => {
  test("fires synchronously when the event is already present", () => {
    append(
      JSON.stringify({
        type: "subagent_done",
        data: { parentTaskId: "T1" },
      }),
    );
    let outcome: unknown = null;
    const watcher = watchForSpawnOutcome({
      sessionFile,
      parentTaskId: "T1",
      onOutcome: (o) => (outcome = o),
      setIntervalFn: () => null,
      clearIntervalFn: () => undefined,
    });
    expect(watcher.fired).toBe(true);
    expect(outcome).not.toBeNull();
  });

  test("polls and fires on the next tick when the event arrives later", () => {
    let tick: (() => void) | null = null;
    const handle = Symbol("handle");
    let cleared: unknown = null;

    let outcome: unknown = null;
    const watcher = watchForSpawnOutcome({
      sessionFile,
      parentTaskId: "T1",
      onOutcome: (o) => (outcome = o),
      setIntervalFn: (h) => {
        tick = h;
        return handle;
      },
      clearIntervalFn: (h) => {
        cleared = h;
      },
    });
    expect(watcher.fired).toBe(false);
    expect(tick).not.toBeNull();

    // Simulate the agent appending the event between ticks.
    append(
      JSON.stringify({
        type: "subagent_done",
        data: { parentTaskId: "T1" },
      }),
    );
    tick!();

    expect(watcher.fired).toBe(true);
    expect(outcome).not.toBeNull();
    expect(cleared).toBe(handle);
  });

  test("ignores events for other tasks", () => {
    let tick: (() => void) | null = null;
    let outcome: unknown = null;
    watchForSpawnOutcome({
      sessionFile,
      parentTaskId: "T1",
      onOutcome: (o) => (outcome = o),
      setIntervalFn: (h) => {
        tick = h;
        return null;
      },
      clearIntervalFn: () => undefined,
    });
    append(
      JSON.stringify({
        type: "subagent_done",
        data: { parentTaskId: "OTHER" },
      }),
    );
    tick!();
    expect(outcome).toBeNull();
  });

  test("stop() halts polling", () => {
    let tickCount = 0;
    const handle = Symbol("handle");
    let cleared = false;
    const watcher = watchForSpawnOutcome({
      sessionFile,
      parentTaskId: "T1",
      onOutcome: () => undefined,
      setIntervalFn: (h) => {
        tickCount += 1;
        void h;
        return handle;
      },
      clearIntervalFn: (h) => {
        if (h === handle) {
          cleared = true;
        }
      },
    });
    watcher.stop();
    expect(cleared).toBe(true);
    // Subsequent stop() calls are no-ops.
    watcher.stop();
    expect(tickCount).toBe(1);
  });

  test("does not fire twice for the same event", () => {
    append(
      JSON.stringify({
        type: "subagent_done",
        data: { parentTaskId: "T1" },
      }),
    );
    let fires = 0;
    let tick: (() => void) | null = null;
    watchForSpawnOutcome({
      sessionFile,
      parentTaskId: "T1",
      onOutcome: () => {
        fires += 1;
      },
      setIntervalFn: (h) => {
        tick = h;
        return null;
      },
      clearIntervalFn: () => undefined,
    });
    expect(fires).toBe(1);
    if (tick) {
      tick();
    }
    expect(fires).toBe(1);
  });
});
