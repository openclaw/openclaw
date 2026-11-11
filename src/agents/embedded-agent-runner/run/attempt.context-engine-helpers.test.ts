import { expect, it } from "vitest";
import type { AssistantMessage } from "../../../llm/types.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  buildLoopPromptCacheInfo,
  findLatestUncompactedAttemptUsageSnapshot,
} from "./attempt-context-engine-helpers.js";

function assistant(
  usage: Record<string, number>,
  timestamp: number | string = 1,
  stopReason: AssistantMessage["stopReason"] = "stop",
) {
  return castAgentMessage({ role: "assistant", content: "", timestamp, stopReason, usage });
}
const seed = castAgentMessage({ role: "user", content: "seed", timestamp: 1 });
const touchedAt = "2026-04-16T16:49:59.536Z";

it("does not resurrect transcript usage across a compaction retry", () => {
  expect(
    findLatestUncompactedAttemptUsageSnapshot({
      messagesSnapshot: [assistant({ input: 12, output: 4, totalTokens: 16 })],
      prePromptMessageCount: 0,
      compactionOccurred: true,
    }),
  ).toBeUndefined();
});

it.each([
  {
    name: "does not reuse a prior turn's usage when the current attempt has no assistant",
    messages: [seed, assistant({ input: 99, output: 7, cacheRead: 1234, total: 1340 }, 2)],
    count: 2,
    expected: undefined,
  },
  {
    name: "keeps the latest nonzero usage when an aborted assistant reports zeros",
    messages: [
      seed,
      assistant({ input: 38_333, output: 66, cacheRead: 120_320, total: 158_719 }, touchedAt),
      assistant(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        "2026-04-16T16:50:00.000Z",
        "aborted",
      ),
    ],
    count: 1,
    retention: "short" as const,
    expected: {
      lastCallUsage: { input: 38_333, cacheRead: 120_320, total: 158_719 },
      lastCacheTouchAt: Date.parse(touchedAt),
    },
  },
  {
    name: "falls back to the persisted cache touch when loop usage has no cache metrics",
    messages: [seed, assistant({ input: 1, output: 2, total: 3 }, touchedAt)],
    count: 1,
    retention: "short" as const,
    fallbackLastCacheTouchAt: 123,
    expected: { retention: "short", lastCallUsage: { total: 3 }, lastCacheTouchAt: 123 },
  },
])("$name", ({ messages, count, expected, retention, fallbackLastCacheTouchAt }) => {
  const actual = buildLoopPromptCacheInfo({
    messagesSnapshot: messages,
    prePromptMessageCount: count,
    retention,
    fallbackLastCacheTouchAt,
  });
  if (expected) {
    expect(actual).toMatchObject(expected);
  } else {
    expect(actual).toBeUndefined();
  }
});
