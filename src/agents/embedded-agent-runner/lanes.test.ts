import { afterEach, beforeEach, expect, it } from "vitest";
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
import { resolveGlobalLane } from "./lanes.js";

function sessionContext(
  sessionId: string,
  spawnedBy?: string,
  sessionKey = `agent:main:subagent:${sessionId}`,
) {
  return { sessionId, spawnedBy, sessionKey };
}

function subagentLane(...args: Parameters<typeof sessionContext>) {
  return resolveGlobalLane(CommandLane.Subagent, sessionContext(...args));
}

function expectLane(lane: string, activeCount: number, queuedCount = 0, maxConcurrent?: number) {
  expect(getCommandLaneSnapshot(lane)).toMatchObject({
    activeCount,
    queuedCount,
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
  });
}

it("normalizes global lanes and isolates nested cron admission (#44805)", () => {
  const cases: Array<[string | undefined, string, Parameters<typeof resolveGlobalLane>[1]?]> = [
    [undefined, CommandLane.Main],
    ["  ", CommandLane.Main],
    ["  cron  ", CommandLane.CronNested],
    [" custom ", "custom"],
    [" subagent ", "subagent:agent:main:parent", sessionContext("child", " agent:main:parent ")],
    [
      " subagent ",
      "subagent:agent:main:subagent:orphan",
      sessionContext("orphan", " ", " agent:main:subagent:orphan "),
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

beforeEach(resetCommandQueueStateForTest);
afterEach(resetCommandQueueStateForTest);

it("caps collectors independently while a single-slot child awaits its own child", async () => {
  const maxConcurrent = 32;
  setCommandLaneConcurrency(CommandLane.Subagent, 1);
  const release = createDeferred();
  const cancelNested = new AbortController();
  const swarmExecutionLane = {
    lane: 'subagent:swarm:["main","agent:main:parent","group"]',
    maxConcurrent,
  };
  const lane = resolveGlobalLane(CommandLane.Subagent, {
    ...sessionContext("collector", "agent:main:parent"),
    swarmExecutionLane,
  });
  const runs = Array.from({ length: 60 }, () =>
    enqueueCommandInLane(lane, async () => await release.promise, { maxConcurrent }),
  );
  const ordinaryLane = subagentLane("ordinary", "agent:main:parent");
  const nestedLane = subagentLane("grandchild", "agent:main:subagent:ordinary");
  runs.push(
    enqueueCommandInLane(ordinaryLane, () =>
      enqueueCommandInLane(nestedLane, () => release.promise, {
        abortSignal: cancelNested.signal,
      }),
    ),
  );
  try {
    expectLane(lane, maxConcurrent, 60 - maxConcurrent, maxConcurrent);
    expectLane(ordinaryLane, 1);
    expectLane(nestedLane, 1, 0, 1);
    const diagnostics = getCommandLaneDiagnostics();
    expect(diagnostics.lanes.find((entry) => entry.lane === lane)).toMatchObject({
      concurrencyScope: "swarm",
      swarmGroupKey: '["main","agent:main:parent","group"]',
    });
    setCommandLaneConcurrency(CommandLane.Subagent, 4);
    expect(getCommandLaneSnapshot(lane).maxConcurrent).toBe(maxConcurrent);
  } finally {
    release.resolve();
    cancelNested.abort();
    await Promise.all(runs);
  }
  expect(listCommandLaneTotals().some((entry) => entry.lane === lane)).toBe(false);
});
