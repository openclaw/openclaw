import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  resolveRunTimeoutDuringCompaction,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
  trimToContinuableTail,
} from "./compaction-timeout.js";

type Snapshot = Parameters<typeof selectCompactionTimeoutSnapshot>[0]["currentSnapshot"];

function expectSelectedSnapshot(
  preCompactionSnapshot: Snapshot | null,
  currentSnapshot: Snapshot,
  source: "current" | "pre-compaction",
  messagesSnapshot: Snapshot,
) {
  expect(
    selectCompactionTimeoutSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot,
      preCompactionSessionId: "session-pre",
      currentSnapshot,
      currentSessionId: "session-current",
    }),
  ).toEqual({
    source,
    sessionIdUsed: source === "current" ? "session-current" : "session-pre",
    messagesSnapshot,
  });
}

describe("compaction-timeout helpers", () => {
  it("flags a timeout while compaction is pending", () => {
    expect(
      shouldFlagCompactionTimeout({
        isTimeout: true,
        isCompactionPendingOrRetrying: true,
        isCompactionInFlight: false,
      }),
    ).toBe(true);
  });

  it.each([
    ["extends the first compaction timeout", false, true, false, "extend"],
    ["aborts after compaction grace", true, false, true, "abort"],
    ["aborts without active compaction", false, false, false, "abort"],
  ] as const)(
    "%s",
    (_name, isCompactionPendingOrRetrying, isCompactionInFlight, graceAlreadyUsed, expected) => {
      expect(
        resolveRunTimeoutDuringCompaction({
          isCompactionPendingOrRetrying,
          isCompactionInFlight,
          graceAlreadyUsed,
        }),
      ).toBe(expected);
    },
  );

  it("keeps tool-result tails continuable after compaction timeout", () => {
    const pre = [
      castAgentMessage({ role: "user", content: "pre-user" }),
      castAgentMessage({ role: "assistant", content: "tool call" }),
      makeTextToolResult("call-1", "lookup", "result", false, 1),
      castAgentMessage({ role: "assistant", content: "pre-assistant" }),
    ];
    expectSelectedSnapshot(
      pre,
      [castAgentMessage({ role: "user", content: "current-user" })],
      "pre-compaction",
      pre.slice(0, 3),
    );
  });

  it("keeps replay-normalized summary tails continuable after compaction timeout", () => {
    const summary = castAgentMessage({
      role: "compactionSummary",
      summary: "older work was summarized",
      tokensBefore: 120_000,
      timestamp: 1,
    });
    expectSelectedSnapshot(null, [summary], "current", [summary]);
  });

  it("returns an empty snapshot when compaction timeout leaves only assistant-tailed snapshots", () => {
    expectSelectedSnapshot(
      [castAgentMessage({ role: "assistant", content: "pre" })],
      [castAgentMessage({ role: "assistant", content: "current" })],
      "current",
      [],
    );
  });

  it("normalizes an excluded custom tail for compaction recovery exits", () => {
    const normalized = trimToContinuableTail([
      castAgentMessage({ role: "user", content: "safe" }),
      castAgentMessage({
        role: "custom",
        customType: "display-note",
        content: "display-only activity",
        display: true,
        excludeFromContext: true,
        timestamp: 2,
      }),
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized?.at(-1)?.role).not.toBe("assistant");
  });
});
