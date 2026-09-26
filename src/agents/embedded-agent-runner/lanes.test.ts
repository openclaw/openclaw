// Coverage for global and per-session command lane normalization.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";

describe("resolveGlobalLane", () => {
  it("defaults to main lane when no lane is provided", () => {
    expect(resolveGlobalLane()).toBe(CommandLane.Main);
    for (const lane of ["", "  "]) {
      expect(resolveGlobalLane(lane)).toBe(CommandLane.Main);
    }
  });

  it("maps cron lane to cron-nested lane to prevent deadlocks", () => {
    // When cron jobs trigger nested agent runs, the outer execution holds the
    // cron lane slot. Inner work must use a separate lane to avoid deadlock.
    // See: https://github.com/openclaw/openclaw/issues/44805
    for (const lane of ["cron", "  cron  "]) {
      expect(resolveGlobalLane(lane)).toBe(CommandLane.CronNested);
    }
  });

  it("preserves other lanes as-is", () => {
    for (const [lane, expected] of [
      ["main", CommandLane.Main],
      ["cron-nested", CommandLane.CronNested],
      ["background:core:review", "background:core:review"],
      ["nested", CommandLane.Nested],
      ["custom-lane", "custom-lane"],
      [" custom ", "custom"],
    ] as const) {
      expect(resolveGlobalLane(lane)).toBe(expected);
    }
  });

  it.each([
    {
      context: {
        spawnedBy: " agent:main:parent ",
        sessionKey: "agent:main:subagent:child",
        sessionId: "child",
      },
      expected: "subagent:agent:main:parent",
    },
    {
      context: { spawnedBy: " ", sessionKey: " agent:main:subagent:orphan ", sessionId: "orphan" },
      expected: "subagent:agent:main:subagent:orphan",
    },
    {
      context: { sessionId: " standalone-child " },
      expected: "subagent:standalone-child",
    },
  ])("uses the spawning or current session for subagent admission", ({ context, expected }) => {
    expect(resolveGlobalLane(" subagent ", context)).toBe(expected);
  });

  it("rejects subagent admission without a session identity", () => {
    for (const context of [undefined, { spawnedBy: " ", sessionKey: " ", sessionId: " " }]) {
      expect(() => resolveGlobalLane(CommandLane.Subagent, context)).toThrow(
        "requires a parent or current session identity",
      );
    }
  });
});

describe("subagent session concurrency", () => {
  beforeEach(() => {
    resetCommandQueueStateForTest();
  });

  afterEach(() => {
    resetCommandQueueStateForTest();
  });

  it("admits another parent's children while saturated siblings remain queued in order", async () => {
    setCommandLaneConcurrency(CommandLane.Subagent, 2);
    const release = createDeferred();
    const firstChildStarted = createDeferred();
    const started: string[] = [];
    const runChild = (spawnedBy: string, child: string) =>
      enqueueCommandInLane(
        resolveGlobalLane(CommandLane.Subagent, {
          spawnedBy,
          sessionKey: `agent:main:subagent:${child}`,
          sessionId: child,
        }),
        async () => {
          started.push(child);
          if (child === "a1") {
            firstChildStarted.resolve();
          }
          await release.promise;
        },
      );
    const children = [
      runChild("agent:main:parent-a", "a1"),
      runChild("agent:main:parent-a", "a2"),
      runChild("agent:main:parent-a", "a3"),
      runChild("agent:main:parent-a", "a4"),
      runChild("agent:main:parent-b", "b1"),
    ];

    try {
      await firstChildStarted.promise;
      expect([...started]).toEqual(["a1", "a2", "b1"]);
    } finally {
      release.resolve();
      await Promise.all(children);
    }
    expect(started).toEqual(["a1", "a2", "b1", "a3", "a4"]);
  });

  it("lets a child await its own child when its parent's only slot is occupied", async () => {
    setCommandLaneConcurrency(CommandLane.Subagent, 1);
    const release = createDeferred();
    const cancelQueuedChild = new AbortController();
    const childKey = "agent:main:subagent:child";
    const grandchildKey = "agent:main:subagent:grandchild";
    const grandchildQueued = createDeferred();
    const grandchildLane = resolveGlobalLane(CommandLane.Subagent, {
      spawnedBy: childKey,
      sessionKey: grandchildKey,
      sessionId: "grandchild",
    });
    const child = enqueueCommandInLane(
      resolveGlobalLane(CommandLane.Subagent, {
        spawnedBy: "agent:main:parent",
        sessionKey: childKey,
        sessionId: "child",
      }),
      async () => {
        const grandchild = enqueueCommandInLane(
          grandchildLane,
          async () => {
            await release.promise;
          },
          { abortSignal: cancelQueuedChild.signal },
        );
        grandchildQueued.resolve();
        return await grandchild;
      },
    );

    try {
      await grandchildQueued.promise;
      expect(getCommandLaneSnapshot(grandchildLane)).toMatchObject({
        activeCount: 1,
        queuedCount: 0,
      });
    } finally {
      release.resolve();
      cancelQueuedChild.abort();
      await Promise.allSettled([child]);
    }
    await expect(child).resolves.toBeUndefined();
  });
});

describe("resolveSessionLane", () => {
  it("defaults to main lane and prefixes with session:", () => {
    for (const lane of ["", "  "]) {
      expect(resolveSessionLane(lane)).toBe("session:main");
    }
  });

  it("adds session: prefix if not present", () => {
    for (const [lane, expected] of [
      ["abc123", "session:abc123"],
      [" xyz ", "session:xyz"],
    ] as const) {
      expect(resolveSessionLane(lane)).toBe(expected);
    }
  });

  it("preserves existing session: prefix", () => {
    for (const lane of ["session:abc", "session:main"]) {
      expect(resolveSessionLane(lane)).toBe(lane);
    }
  });
});
