import { expect, it } from "vitest";
import {
  nativeChunks,
  planUpdate,
  taskUpdate,
  toolStart,
} from "./dispatch.compact-progress.test-support.js";
import {
  appendSlackStreamMock,
  collectNativeTaskUpdates,
  dispatchNativeProgressScenario,
  expectNativeProgressAppend,
  expectNativeProgressStart,
  expectNativeStreamText,
  FINAL_REPLY_TEXT,
  startSlackStreamMock,
  stopSlackStreamMock,
} from "./dispatch.native-stream.test-support.js";
import { requireRecord } from "./dispatch.preview.test-support.js";

const finalPayload = { text: FINAL_REPLY_TEXT };
const cards = { nativeTaskCards: true, reasoning: "cards" };

function expectOneStreamMessage() {
  expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
  expect(appendSlackStreamMock).toHaveBeenCalledTimes(2);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
}

it("keeps the narration presentation unchanged when progress.reasoning is narration", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: { nativeTaskCards: true, reasoning: "narration" },
    events: [
      { kind: "reasoning", text: "Checking", isReasoningSnapshot: true },
      { kind: "reasoning", text: "Checking the Slack handler", isReasoningSnapshot: true },
    ],
  });

  expect(collectNativeTaskUpdates()).toEqual([]);
  expectNativeStreamText("Checking");
  // A snapshot arriving inside the throttle window rides the completion append.
  expectNativeProgressAppend(0, [{ type: "markdown_text", text: " the Slack handler" }]);
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
  expectOneStreamMessage();
});

it("renders streamed reasoning as segment task cards instead of narration", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: cards,
    events: [
      { kind: "reasoning", text: "Checking", isReasoningSnapshot: true },
      { kind: "reasoning", text: "Checking the Slack handler", isReasoningSnapshot: true },
      { kind: "reasoning_end" },
    ],
  });

  const reasoningCardId = expect.stringMatching(/^reasoning_1_[a-f0-9]{8}$/u);
  expectNativeProgressStart([
    planUpdate("Thinking"),
    taskUpdate(reasoningCardId, "🧠 Checking", "in_progress"),
  ]);
  // The second snapshot arrives inside the throttle window and rides the
  // completion append, sealed by the end of the reasoning phase.
  expectNativeProgressAppend(0, [
    planUpdate(expect.stringMatching(/^Thought for \d+s$/u)),
    taskUpdate(reasoningCardId, "🧠 Checking the Slack handler", "complete"),
  ]);
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
  // A short think is one stream message.
  expectOneStreamMessage();
  const streamTexts = [...startSlackStreamMock.mock.calls, ...appendSlackStreamMock.mock.calls]
    .map((call) => requireRecord(call[0], "native stream call").text)
    .filter((text): text is string => typeof text === "string");
  expect(streamTexts.join("")).not.toContain("Checking");
});

it("merges reasoning deltas, prefix extensions, and flagged snapshots into one card", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: cards,
    events: [
      { kind: "reasoning", text: "Reading" },
      { kind: "reasoning", text: " the handler" },
      { kind: "reasoning", text: "Reading the handler now" },
      { kind: "reasoning", text: "<think>Fresh snapshot</think>", isReasoningSnapshot: true },
    ],
  });

  const reasoningCardId = expect.stringMatching(/^reasoning_1_[a-f0-9]{8}$/u);
  expect(collectNativeTaskUpdates()).toEqual([
    taskUpdate(reasoningCardId, "🧠 Reading", "in_progress"),
    taskUpdate(reasoningCardId, "🧠 Fresh snapshot", "complete"),
  ]);
});

it.each([
  { split: "a trailing space", deltas: ["Reading ", "the handler"], text: "Reading the handler" },
  {
    split: "a wrapper tag closed by a later delta",
    deltas: ["<think>Fresh", " snapshot</think>"],
    text: "Fresh snapshot",
  },
])("keeps the raw reasoning across deltas split at $split", async ({ deltas, text }) => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: cards,
    events: [
      ...deltas.map((delta) => ({ kind: "reasoning" as const, text: delta })),
      { kind: "reasoning_end" },
    ],
  });

  const tasks = collectNativeTaskUpdates();
  expect(new Set(tasks.map((task) => task.id)).size).toBe(1);
  expect(tasks.at(-1)).toEqual(
    taskUpdate(expect.stringMatching(/^reasoning_1_[a-f0-9]{8}$/u), `🧠 ${text}`, "complete"),
  );
});

it("seals the open reasoning card at a tool boundary so later thinking starts a new card", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: cards,
    events: [
      { kind: "reasoning", text: "Plan the fix." },
      toolStart({ command: "pnpm test" }, { itemId: "tool-1" }),
      { kind: "reasoning", text: "Tests pass, now summarize." },
      { kind: "reasoning_end" },
    ],
  });

  const tasks = collectNativeTaskUpdates();
  const ids = [...new Set(tasks.map((task) => String(task.id)))];
  expect(ids).toEqual([
    expect.stringMatching(/^reasoning_1_[a-f0-9]{8}$/u),
    expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u),
    expect.stringMatching(/^reasoning_2_[a-f0-9]{8}$/u),
  ]);
  expect(tasks.findLast((task) => task.id === ids[0])).toEqual(
    taskUpdate(ids[0], "🧠 Plan the fix.", "complete"),
  );
  expect(tasks.findLast((task) => task.id === ids[2])).toEqual(
    taskUpdate(ids[2], "🧠 Tests pass, now summarize.", "complete"),
  );
  const planTitles = nativeChunks(appendSlackStreamMock.mock.calls)
    .filter((chunk) => chunk.type === "plan_update")
    .map((chunk) => chunk.title);
  expect(planTitles.at(-1)).toMatch(/^Thought for \d+s, 1 tool call$/u);
});

it("keeps an explicit progress title through reasoning card completion", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: { ...cards, label: "Shelling" },
    events: [{ kind: "reasoning", text: "Checking the handler" }, { kind: "reasoning_end" }],
  });

  const plans = nativeChunks([
    ...startSlackStreamMock.mock.calls,
    ...appendSlackStreamMock.mock.calls,
  ]).filter((chunk) => chunk.type === "plan_update");
  expect(plans).toEqual([planUpdate("Shelling")]);
});

it("keeps reasoning in narration on the quiet card even when cards are configured", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: { ...cards, style: "card", toolProgress: false },
    events: [
      { kind: "reasoning", text: "Checking", isReasoningSnapshot: true },
      { kind: "reasoning", text: "Checking the Slack handler", isReasoningSnapshot: true },
    ],
  });

  expect(
    collectNativeTaskUpdates().filter((task) => String(task.id).startsWith("reasoning_")),
  ).toEqual([]);
  expectNativeStreamText("Checking");
});
