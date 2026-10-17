import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getCommandLaneDiagnostics } from "../../process/command-lane-diagnostics.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  listCommandLaneTotals,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";

function subagentLane(sessionId: string, spawnedBy?: string) {
  return resolveGlobalLane(CommandLane.Subagent, {
    sessionId,
    sessionKey: `agent:main:subagent:${sessionId}`,
    spawnedBy,
  });
}

describe("resolveGlobalLane", () => {
  it("normalizes global lanes and isolates nested cron admission (#44805)", () => {
    const cases: Array<[string | undefined, string, Parameters<typeof resolveGlobalLane>[1]?]> = [
      [undefined, CommandLane.Main],
      ["", CommandLane.Main],
      ["  ", CommandLane.Main],
      ["cron", CommandLane.CronNested],
      ["  cron  ", CommandLane.CronNested],
      ["main", CommandLane.Main],
      ["cron-nested", CommandLane.CronNested],
      ["background:core:review", "background:core:review"],
      ["nested", CommandLane.Nested],
      ["custom-lane", "custom-lane"],
      [" custom ", "custom"],
      [
        " subagent ",
        "subagent:agent:main:parent",
        {
          spawnedBy: " agent:main:parent ",
          sessionKey: "agent:main:subagent:child",
          sessionId: "child",
        },
      ],
      [
        " subagent ",
        "subagent:agent:main:subagent:orphan",
        {
          spawnedBy: " ",
          sessionKey: " agent:main:subagent:orphan ",
          sessionId: "orphan",
        },
      ],
      [" subagent ", "subagent:standalone-child", { sessionId: " standalone-child " }],
    ];
    for (const [lane, expected, context] of cases) {
      expect(resolveGlobalLane(lane, context)).toBe(expected);
    }
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
  beforeEach(resetCommandQueueStateForTest);
  afterEach(resetCommandQueueStateForTest);

  it("executes 60 collectors with an independent group cap of 32", async () => {
    const maxConcurrent = 32;
    setCommandLaneConcurrency(CommandLane.Subagent, 8);
    const release = createDeferred();
    const swarmExecutionLane = {
      lane: 'subagent:swarm:["main","agent:main:parent","group"]',
      maxConcurrent,
    };
    const lane = resolveGlobalLane(CommandLane.Subagent, {
      sessionId: "collector",
      spawnedBy: "agent:main:parent",
      swarmExecutionLane,
    });
    const runs = Array.from({ length: 60 }, () =>
      enqueueCommandInLane(lane, async () => await release.promise, { maxConcurrent }),
    );
    const ordinaryLane = subagentLane("ordinary", "agent:main:parent");
    runs.push(enqueueCommandInLane(ordinaryLane, async () => await release.promise));
    const nestedLane = subagentLane("grandchild", "agent:main:subagent:collector");
    runs.push(enqueueCommandInLane(nestedLane, async () => await release.promise));
    try {
      expect(getCommandLaneSnapshot(lane)).toMatchObject({
        maxConcurrent,
        activeCount: maxConcurrent,
        queuedCount: 60 - maxConcurrent,
      });
      expect(getCommandLaneSnapshot(ordinaryLane)).toMatchObject({
        activeCount: 1,
        queuedCount: 0,
      });
      expect(getCommandLaneSnapshot(nestedLane)).toMatchObject({
        maxConcurrent: 8,
        activeCount: 1,
        queuedCount: 0,
      });
      const diagnostics = getCommandLaneDiagnostics();
      expect(diagnostics.lanes.find((entry) => entry.lane === lane)).toMatchObject({
        concurrencyScope: "swarm",
        swarmGroupKey: '["main","agent:main:parent","group"]',
        activeCount: maxConcurrent,
        queuedCount: 60 - maxConcurrent,
      });
      expect(diagnostics.lanes.find((entry) => entry.lane === "subagent")).toMatchObject({
        concurrencyScope: "session",
        activeCount: 2,
        queuedCount: 0,
      });
      setCommandLaneConcurrency(CommandLane.Subagent, 4);
      expect(getCommandLaneSnapshot(lane).maxConcurrent).toBe(maxConcurrent);
    } finally {
      release.resolve();
      await Promise.all(runs);
    }
    expect(listCommandLaneTotals().some((entry) => entry.lane === lane)).toBe(false);
  });

  it("admits another parent's children while saturated siblings remain queued in order", async () => {
    setCommandLaneConcurrency(CommandLane.Subagent, 2);
    const release = createDeferred();
    const firstChildStarted = createDeferred();
    const started: string[] = [];
    const runChild = (spawnedBy: string, child: string) =>
      enqueueCommandInLane(subagentLane(child, spawnedBy), async () => {
        started.push(child);
        if (child === "a1") {
          firstChildStarted.resolve();
        }
        await release.promise;
      });
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
    const grandchildQueued = createDeferred();
    const grandchildLane = subagentLane("grandchild", childKey);
    const child = enqueueCommandInLane(subagentLane("child", "agent:main:parent"), async () => {
      const grandchild = enqueueCommandInLane(grandchildLane, async () => await release.promise, {
        abortSignal: cancelQueuedChild.signal,
      });
      grandchildQueued.resolve();
      return await grandchild;
    });

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
  it("normalizes session identities without duplicating the prefix", () => {
    for (const [lane, expected] of [
      ["", "session:main"],
      ["  ", "session:main"],
      ["abc123", "session:abc123"],
      [" xyz ", "session:xyz"],
      ["session:abc", "session:abc"],
      ["session:main", "session:main"],
    ] as const) {
      expect(resolveSessionLane(lane)).toBe(expected);
    }
  });
});
