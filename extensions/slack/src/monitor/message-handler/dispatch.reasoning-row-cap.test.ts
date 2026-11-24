import { expect, it } from "vitest";
import { resolveSlackNativeMessageRowLimit } from "./dispatch-helpers.js";
import { toolStart } from "./dispatch.compact-progress.test-support.js";
import {
  cardSegments,
  carriesText,
  chunksOf,
  deliverRepliesMock,
  dispatchCardsScenario,
  expectStreamMessages,
  type NativeStreamCall,
  planTitlesOf,
  range,
  reasoningIdsOf,
  reasoningSnapshot,
  settle,
} from "./dispatch.native-stream.test-support.js";

// An explicit progress.maxLines caps the task rows of each native stream message.

const toolStarts = (from: number, to: number) =>
  range(from, to).map((index) =>
    toolStart({ command: `pnpm test --filter case-${index}` }, { itemId: `tool-${index}` }),
  );

it.each([
  { maxLines: undefined, rows: 50 },
  { maxLines: 8, rows: 8 },
  { maxLines: 80, rows: 50 },
  { maxLines: 1, rows: 2 },
])("holds $rows rows per native message with maxLines $maxLines", ({ maxLines, rows }) => {
  const progress = maxLines === undefined ? {} : { maxLines };
  expect(resolveSlackNativeMessageRowLimit({ streaming: { mode: "progress", progress } })).toBe(
    rows,
  );
});

/** Distinct task ids per message, in first-seen order, without their hash suffix. */
function rowIdsPerMessage(messages: NativeStreamCall[][]): string[][] {
  return messages.map((message) => [
    ...new Set(
      message
        .flatMap((call) => chunksOf(call.params))
        .filter((chunk) => chunk.type === "task_update")
        .map((chunk) => String(chunk.id).replace(/_[a-f0-9]{8}$/u, "")),
    ),
  ]);
}

it("rolls at an explicit maxLines and delivers every row once", async () => {
  const segments = cardSegments(8);
  await dispatchCardsScenario({
    progress: { maxLines: 8 },
    events: [
      reasoningSnapshot(segments.slice(0, 4).join(" ")),
      settle,
      ...toolStarts(1, 6),
      settle,
      reasoningSnapshot(segments.slice(4, 8).join(" ")),
      settle,
      ...toolStarts(7, 12),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = expectStreamMessages();
  const rows = rowIdsPerMessage(messages);
  expect(messages.length).toBeGreaterThanOrEqual(3);
  for (const ids of rows) {
    expect(ids.length).toBeLessThanOrEqual(8);
  }
  // Twenty rows, each on exactly one message, cards in order.
  expect(rows.flat().toSorted()).toEqual(
    [
      ...range(1, 8).map((index) => `reasoning_${index}`),
      ...range(1, 12).map((index) => `tool_${index}`),
    ].toSorted(),
  );
  expect(messages.flatMap((message) => reasoningIdsOf(message))).toEqual(range(1, 8));
  for (const message of messages.slice(0, -1)) {
    expect(planTitlesOf(message).at(-1)).toBe("Thinking, continued below");
  }
  expect(carriesText(messages.at(-1) ?? [])).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("caps an explicit maxLines above Slack's plan block at 50 rows", async () => {
  await dispatchCardsScenario({
    progress: { maxLines: 80 },
    events: [...toolStarts(1, 60), settle],
  });

  const rows = rowIdsPerMessage(expectStreamMessages(2));
  expect(rows.map((ids) => ids.length)).toEqual([50, 10]);
  expect(new Set(rows.flat()).size).toBe(60);
});

it("caps the quiet card's reasoning rows at an explicit maxLines", async () => {
  await dispatchCardsScenario({
    progress: { style: "card", toolProgress: false, maxLines: 4 },
    events: [
      reasoningSnapshot(cardSegments(9).join(" ")),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = expectStreamMessages();
  const rows = rowIdsPerMessage(messages);
  // The summary row takes one of the four slots on every message.
  for (const ids of rows) {
    expect(ids.length).toBeLessThanOrEqual(4);
    expect(ids[0]).toBe("openclaw_summary");
  }
  expect(messages.flatMap((message) => reasoningIdsOf(message))).toEqual(range(1, 9));
  expect(carriesText(messages.at(-1) ?? [])).toBe(true);
});
