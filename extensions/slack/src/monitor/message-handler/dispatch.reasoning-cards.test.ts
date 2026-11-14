import { expect, it, vi } from "vitest";
import {
  checkpoint,
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

function expectOneStreamMessage() {
  expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
  expect(appendSlackStreamMock).toHaveBeenCalledTimes(2);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
}

it("renders streamed reasoning as segment task cards instead of narration", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
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
    progress: { nativeTaskCards: true, label: "Shelling" },
    events: [{ kind: "reasoning", text: "Checking the handler" }, { kind: "reasoning_end" }],
  });

  const plans = nativeChunks([
    ...startSlackStreamMock.mock.calls,
    ...appendSlackStreamMock.mock.calls,
  ]).filter((chunk) => chunk.type === "plan_update");
  expect(plans).toEqual([planUpdate("Shelling")]);
});

function streamCalls() {
  const calls = [
    ...startSlackStreamMock.mock.calls.map((call) => ["start", call] as const),
    ...appendSlackStreamMock.mock.calls.map((call) => ["append", call] as const),
    ...stopSlackStreamMock.mock.calls.map((call) => ["stop", call] as const),
  ];
  return calls.map(([kind, call]) => {
    const { session: _session, client: _client, ...rest } = requireRecord(call[0], "stream call");
    return Object.assign(rest, { kind });
  });
}

it("shows reasoning rows but no tool rows on the quiet card", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: { nativeTaskCards: true, style: "card", toolProgress: false },
    events: [
      { kind: "reasoning", text: "Checking", isReasoningSnapshot: true },
      { kind: "reasoning", text: "Checking the Slack handler", isReasoningSnapshot: true },
      toolStart({ command: "pnpm test" }, { itemId: "tool-1" }),
      { kind: "reasoning", text: "Checking the results", isReasoningSnapshot: true },
      { kind: "reasoning_end" },
    ],
  });

  const reasoningCardId = (index: number) =>
    expect.stringMatching(new RegExp(`^reasoning_${index}_[a-f0-9]{8}$`, "u"));
  // The summary row keeps its place and headline; the reasoning rows sit below
  // it, and the tool call seals the first card but adds no row of its own.
  expect(streamCalls()).toEqual([
    expect.objectContaining({
      kind: "start",
      chunks: [
        planUpdate("Working"),
        taskUpdate("openclaw_summary", "Working", "in_progress"),
        taskUpdate(reasoningCardId(1), "🧠 Checking", "in_progress"),
      ],
    }),
    {
      kind: "append",
      chunks: [
        planUpdate("Completed"),
        taskUpdate("openclaw_summary", "Completed", "complete"),
        taskUpdate(reasoningCardId(1), "🧠 Checking the Slack handler", "complete"),
        taskUpdate(reasoningCardId(2), "🧠 Checking the results", "complete"),
      ],
    },
    { kind: "append", text: `\n${FINAL_REPLY_TEXT}`, chunks: [] },
    { kind: "stop" },
  ]);
  expect(collectNativeTaskUpdates().map((task) => String(task.id))).not.toContainEqual(
    expect.stringMatching(/^tool_/u),
  );
});

it("renders the quiet card with reasoning off exactly as before", async () => {
  await dispatchNativeProgressScenario({
    finalPayload,
    progress: { nativeTaskCards: true, style: "card", toolProgress: false },
    events: [
      toolStart({ command: "pnpm lint" }, { itemId: "tool-1" }),
      toolStart({ command: "pnpm test" }, { itemId: "tool-2" }),
    ],
  });

  // The call sequence main produces for this turn: one summary row, no other rows.
  expect(streamCalls()).toEqual([
    expect.objectContaining({
      kind: "start",
      chunks: [planUpdate("Working"), taskUpdate("openclaw_summary", "Working", "in_progress")],
    }),
    {
      kind: "append",
      chunks: [planUpdate("Completed"), taskUpdate("openclaw_summary", "Completed", "complete")],
    },
    { kind: "append", text: `\n${FINAL_REPLY_TEXT}`, chunks: [] },
    { kind: "stop" },
  ]);
});

it("caps a long think at the plan-block budget and rolls the rest through a tail card", async () => {
  vi.useFakeTimers();
  // 50 single-card segments: each is 240 characters with no space, numbered.
  const segments = Array.from({ length: 50 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const snapshot = (from: number, to: number) => ({
    kind: "reasoning" as const,
    text: segments.slice(from, to).join(" "),
    isReasoningSnapshot: true,
  });
  const settle = checkpoint(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await dispatchNativeProgressScenario({
    finalPayload,
    events: [
      snapshot(0, 10),
      settle,
      snapshot(0, 20),
      settle,
      toolStart({ command: "pnpm test" }, { itemId: "tool-1" }),
      settle,
      snapshot(20, 30),
      settle,
      snapshot(20, 40),
      settle,
      snapshot(20, 50),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const tasks = collectNativeTaskUpdates();
  const reasoningTasks = tasks.filter((task) => String(task.id).startsWith("reasoning_"));
  const ids = [...new Set(reasoningTasks.map((task) => String(task.id)))];
  // One tool call reserves a row: 47 - 1 = 46 segment cards, then the tail.
  expect(ids).toHaveLength(47);
  expect(ids.slice(0, 46)).toEqual(
    Array.from({ length: 46 }, (_, index) =>
      expect.stringMatching(new RegExp(`^reasoning_${index + 1}_[a-f0-9]{8}$`, "u")),
    ),
  );
  expect(ids[46]).toEqual(expect.stringMatching(/^reasoning_tail_[a-f0-9]{8}$/u));
  for (const task of reasoningTasks) {
    expect(String(task.title).length).toBeLessThanOrEqual(250);
    const index = Number(/^reasoning_(\d+)_/u.exec(String(task.id))?.[1] ?? Number.NaN);
    if (Number.isFinite(index)) {
      // Cards sealed by the tool call carry pre-tool text only.
      expect(Number(/^🧠 s(\d+)x/u.exec(String(task.title))?.[1])).toBe(index);
    }
  }
  const tail = reasoningTasks.filter((task) => String(task.id).startsWith("reasoning_tail_"));
  expect(tail.at(-1)).toMatchObject({ title: `🧠 …${segments[49]?.slice(1)}`, status: "complete" });
  // No identical chunk is sent twice.
  const serialized = tasks.map((task) => JSON.stringify(task));
  expect(new Set(serialized).size).toBe(serialized.length);
  const planTitles = nativeChunks([
    ...startSlackStreamMock.mock.calls,
    ...appendSlackStreamMock.mock.calls,
  ])
    .filter((chunk) => chunk.type === "plan_update")
    .map((chunk) => chunk.title);
  expect(planTitles.at(-1)).toBe("Thought for 7s, 1 tool call");
  expect(planTitles).not.toContainEqual(expect.stringContaining("🧠"));
});

it.each([
  { reasoning: false, evicted: true },
  { reasoning: true, evicted: false },
])(
  "keeps the configured rolling window unless the turn streams reasoning (reasoning: $reasoning)",
  async ({ reasoning, evicted }) => {
    await dispatchNativeProgressScenario({
      finalPayload,
      progress: { nativeTaskCards: true, maxLines: 2 },
      events: [
        ...(reasoning ? [{ kind: "reasoning" as const, text: "Plan the fix." }] : []),
        toolStart({ command: "pnpm lint" }, { itemId: "tool-1" }),
        toolStart({ command: "pnpm build" }, { itemId: "tool-2" }),
        toolStart({ command: "pnpm test" }, { itemId: "tool-3" }),
      ],
    });

    const tasks = collectNativeTaskUpdates();
    // The reconciler retires a row that left the window after the rows still
    // in it, so an evicted first tool row closes out last.
    expect(String(tasks.at(-1)?.id).startsWith("tool_1_")).toBe(evicted);
    expect(tasks.some((task) => String(task.id).startsWith("reasoning_"))).toBe(reasoning);
  },
);
