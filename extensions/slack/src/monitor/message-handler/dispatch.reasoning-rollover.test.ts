import { expect, it, vi } from "vitest";
import {
  planUpdate,
  requireMockCall,
  taskUpdate,
} from "./dispatch.compact-progress.test-support.js";
import {
  appendSlackStreamMock,
  chunksOf,
  collectNativeStreamTimeline,
  deliverRepliesMock,
  dispatchNativeProgressScenario,
  FINAL_REPLY_TEXT,
  type NativeStreamCall,
  planTitlesOf,
  reasoningIdsOf,
  splitNativeStreamMessages,
  startSlackStreamMock,
  stopSlackStreamMock,
  TestSlackStreamMessageTooLongError,
  THREAD_TS,
  useFreshStreamSessions,
} from "./dispatch.native-stream.test-support.js";
import { requireRecord } from "./dispatch.preview.test-support.js";

// Reasoning cards that outgrow one streamed message continue in new messages.

it("rolls a long think into continuation messages, each under the per-message budget", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  // 50 single-card segments: each is 240 characters with no space, numbered.
  const segments = Array.from({ length: 50 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const snapshotUpTo = (count: number) => ({
    kind: "reasoning" as const,
    text: segments.slice(0, count).join(" "),
    isReasoningSnapshot: true,
  });
  const postToolSnapshotUpTo = (count: number) => ({
    kind: "reasoning" as const,
    text: segments.slice(20, count).join(" "),
    isReasoningSnapshot: true,
  });
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      snapshotUpTo(10),
      settle,
      snapshotUpTo(20),
      settle,
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      settle,
      postToolSnapshotUpTo(30),
      settle,
      postToolSnapshotUpTo(40),
      settle,
      postToolSnapshotUpTo(50),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const timeline = collectNativeStreamTimeline();
  const messages = splitNativeStreamMessages(timeline);
  // 24 cards of 245 UTF-8 bytes fit under the 6,000-byte row budget; 50 cards need three messages.
  expect(messages).toHaveLength(3);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(3);
  expect(deliverRepliesMock).not.toHaveBeenCalled();

  // Every segment appears exactly once, in order, and no card is on two messages.
  const perMessageIds = messages.map((message) => reasoningIdsOf(message));
  expect(perMessageIds.flat()).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  for (const ids of perMessageIds) {
    expect(ids.length).toBeLessThanOrEqual(24);
  }
  const [first, second, third] = messages;
  if (!first || !second || !third) {
    throw new Error("expected three stream messages");
  }
  // Card numbering continues across messages.
  expect(perMessageIds[1]?.[0]).toBe((perMessageIds[0]?.at(-1) ?? 0) + 1);
  expect(perMessageIds[2]?.[0]).toBe((perMessageIds[1]?.at(-1) ?? 0) + 1);

  // A rolled message stops with every open row complete and a title that says it continues.
  for (const rolled of [first, second]) {
    const stop = rolled.at(-1);
    expect(stop?.kind).toBe("stop");
    const stopChunks = chunksOf(stop?.params ?? {});
    expect(stopChunks[0]).toEqual(planUpdate("Thinking, continued below"));
    for (const chunk of stopChunks.slice(1)) {
      expect(chunk.type).toBe("task_update");
      expect(chunk.status).toBe("complete");
    }
    expect(planTitlesOf(rolled)).not.toContainEqual(expect.stringMatching(/^Thought for/u));
    expect(rolled.some((call) => call.params.text === `\n${FINAL_REPLY_TEXT}`)).toBe(false);
  }
  // The tool never reports a result here, so it is still running when each
  // message rolls: painted complete on the rolled message (closing it), carried
  // to the next one, and settled by the turn's completion on the last.
  const hasToolRow = (message: NativeStreamCall[]) =>
    message.some((call) => chunksOf(call.params).some((c) => String(c.id).startsWith("tool_1_")));
  expect(hasToolRow(first)).toBe(true);
  expect(chunksOf(first.at(-1)?.params ?? {})).toContainEqual(
    taskUpdate(expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u), "Bash", "complete"),
  );
  expect(hasToolRow(second)).toBe(true);
  expect(hasToolRow(third)).toBe(true);
  expect(chunksOf(third[0]?.params ?? {})).toContainEqual(
    taskUpdate(expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u), "Bash", "in_progress"),
  );

  // A continuation starts in the same thread for the same recipient, titled as a continuation.
  const firstStart = requireRecord(
    requireMockCall(startSlackStreamMock, 0, "first start")[0],
    "first start",
  );
  for (const continuation of [second, third]) {
    const start = continuation[0];
    expect(start?.kind).toBe("start");
    expect(start?.params).toMatchObject({
      channel: firstStart.channel,
      threadTs: THREAD_TS,
      taskDisplayMode: "plan",
      userId: firstStart.userId,
      teamId: firstStart.teamId,
    });
    // The running tool carried over is the headline, as on any message it runs on.
    expect(chunksOf(start?.params ?? {})[0]).toEqual(planUpdate("Bash"));
    expect(chunksOf(start?.params ?? {}).map((chunk) => chunk.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u),
        expect.stringMatching(/^reasoning_\d+_[a-f0-9]{8}$/u),
      ]),
    );
  }

  // The answer and the summary title land on the message that is current at the end.
  expect(planTitlesOf(third).at(-1)).toBe("Thought for 7s, 1 tool call");
  expect(third.some((call) => call.params.text === `\n${FINAL_REPLY_TEXT}`)).toBe(true);
  expect(third.at(-1)?.kind).toBe("stop");
  expect(chunksOf(third.at(-1)?.params ?? {})).toEqual([]);
  for (const call of timeline) {
    for (const chunk of chunksOf(call.params)) {
      if (chunk.type === "task_update") {
        expect(String(chunk.title).length).toBeLessThanOrEqual(250);
      }
    }
  }
  const planTitles = timeline.flatMap((call) => planTitlesOf([call]));
  expect(planTitles).not.toContainEqual(expect.stringContaining("🧠"));
});

it("rolls to a continuation and retries once when Slack rejects a card update with msg_too_long", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      { kind: "reasoning", text: "Plan the fix." },
      settle,
      {
        kind: "checkpoint",
        run: async () => {
          appendSlackStreamMock.mockRejectedValueOnce(new TestSlackStreamMessageTooLongError(""));
        },
      },
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      settle,
      { kind: "reasoning", text: "Tests pass, now summarize." },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages).toHaveLength(2);
  const [first, second] = messages;
  if (!first || !second) {
    throw new Error("expected two stream messages");
  }
  // The rejected append (the card sealed by the tool call) is followed by
  // the rolled stop, nothing else on that message.
  expect(first.map((call) => call.kind)).toEqual(["start", "append", "stop"]);
  expect(chunksOf(first[1]?.params ?? {})).toEqual([
    taskUpdate(expect.stringMatching(/^reasoning_1_[a-f0-9]{8}$/u), "🧠 Plan the fix.", "complete"),
  ]);
  expect(chunksOf(first[2]?.params ?? {})).toEqual([
    planUpdate("Thinking, continued below"),
    taskUpdate(expect.stringMatching(/^reasoning_1_[a-f0-9]{8}$/u), "🧠 Plan the fix.", "complete"),
  ]);
  // The retry carries the rejected rows to the continuation; the turn finishes there.
  expect(second[0]?.params).toMatchObject({ threadTs: THREAD_TS, taskDisplayMode: "plan" });
  expect(chunksOf(second[0]?.params ?? {})).toEqual([
    planUpdate("Bash"),
    taskUpdate(expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u), "Bash", "in_progress"),
  ]);
  expect(reasoningIdsOf(second)).toEqual([2]);
  expect(planTitlesOf(second).at(-1)).toMatch(/^Thought for \d+s, 1 tool call$/u);
  expect(second.some((call) => call.params.text === `\n${FINAL_REPLY_TEXT}`)).toBe(true);
  expect(second.at(-1)?.kind).toBe("stop");
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("delivers every card of a burst wider than a rolling window, once and in order", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 70 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      // One cumulative snapshot admits 70 cards before the paced loop sends again.
      { kind: "reasoning", text: segments.join(" "), isReasoningSnapshot: true },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const timeline = collectNativeStreamTimeline();
  const messages = splitNativeStreamMessages(timeline);
  const perMessageIds = messages.map((message) => reasoningIdsOf(message));
  // No segment is lost to the compositor before its first send, none is repeated.
  expect(perMessageIds.flat()).toEqual(Array.from({ length: 70 }, (_, index) => index + 1));
  expect(messages).toHaveLength(3);
  for (const ids of perMessageIds) {
    expect(ids.length).toBeLessThanOrEqual(24);
  }
  for (const call of timeline) {
    for (const chunk of chunksOf(call.params)) {
      const match = /^reasoning_(\d+)_[a-f0-9]{8}$/u.exec(String(chunk.id));
      if (match) {
        expect(chunk.title).toBe(`🧠 ${segments[Number(match[1]) - 1]}`);
      }
    }
  }
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("carries closeout rows Slack rejected with msg_too_long to the continuation", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 30 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const snapshotUpTo = (count: number) => ({
    kind: "reasoning" as const,
    text: segments.slice(0, count).join(" "),
    isReasoningSnapshot: true,
  });
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      snapshotUpTo(20),
      settle,
      {
        kind: "checkpoint",
        run: async () => {
          // Four of the ten new cards fit this message but Slack rejects the
          // append that carries them, and then the rollover stop as well.
          appendSlackStreamMock.mockRejectedValueOnce(new TestSlackStreamMessageTooLongError(""));
          stopSlackStreamMock.mockRejectedValueOnce(new TestSlackStreamMessageTooLongError(""));
        },
      },
      snapshotUpTo(30),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages).toHaveLength(2);
  const [first, second] = messages;
  if (!first || !second) {
    throw new Error("expected two stream messages");
  }
  // The rejected append carried the four cards, the rejected closeout the
  // completion of card 20; a stop without chunks ends that message.
  expect(first.map((call) => call.kind)).toEqual(["start", "append", "append", "stop", "stop"]);
  expect(reasoningIdsOf(first.slice(0, 2))).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  expect(reasoningIdsOf([first[2] as NativeStreamCall])).toEqual(
    expect.arrayContaining([21, 22, 23, 24]),
  );
  expect(reasoningIdsOf([first[3] as NativeStreamCall])).toEqual([20]);
  expect(first[4]?.params.chunks).toBeUndefined();
  // Every card Slack did not take reaches the continuation in order: the four
  // in the rejected closeout, and card 20, whose completion the closeout
  // carried and Slack refused; the turn finishes there.
  expect(reasoningIdsOf(second)).toEqual(Array.from({ length: 11 }, (_, index) => index + 20));
  expect(reasoningIdsOf([second[0] as NativeStreamCall])).toEqual(
    Array.from({ length: 11 }, (_, index) => index + 20),
  );
  expect(second.some((call) => call.params.text === `\n${FINAL_REPLY_TEXT}`)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("carries the rejected extension of a partial card to the continuation", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 30 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  // Card 20 is "held" alone on the first message; its extension "held rest"
  // (226 bytes) still fits one card, and "rest" alone starts a card past a
  // word cut in the second half of the window.
  const held = "h".repeat(100);
  const rest = "t".repeat(125);
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  let rejectedStopChunks: Array<Record<string, unknown>> = [];
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      // Cards 1-19 complete, card 20 partial on the first message.
      {
        kind: "reasoning",
        text: `${segments.slice(0, 19).join(" ")} ${held}`,
        isReasoningSnapshot: true,
      },
      settle,
      {
        kind: "checkpoint",
        run: async () => {
          appendSlackStreamMock.mockRejectedValueOnce(new TestSlackStreamMessageTooLongError(""));
          stopSlackStreamMock.mockImplementationOnce(async (input) => {
            rejectedStopChunks = chunksOf(requireRecord(input, "stop"));
            throw new TestSlackStreamMessageTooLongError("");
          });
        },
      },
      // Card 20 grows and ten more cards arrive; the append and then the
      // rollover closeout carrying the extension are rejected, so Slack
      // keeps the shorter title.
      {
        kind: "reasoning",
        text: `${segments.slice(0, 19).join(" ")} ${held} ${rest} ${segments.slice(19, 29).join(" ")}`,
        isReasoningSnapshot: true,
      },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages).toHaveLength(2);
  const [first, second] = messages;
  if (!first || !second) {
    throw new Error("expected two stream messages");
  }
  expect(first.map((call) => call.kind)).toEqual(["start", "append", "append", "stop", "stop"]);
  expect(rejectedStopChunks).toContainEqual(
    taskUpdate(
      expect.stringMatching(/^reasoning_20_[a-f0-9]{8}$/u),
      `🧠 ${held} ${rest}`,
      "complete",
    ),
  );
  // Slack holds only the short title for card 20, so the whole card, with the
  // text it never took, opens the continuation ahead of the deferred cards.
  const continuationTitles = second.flatMap((call) =>
    chunksOf(call.params)
      .filter((chunk) => /^reasoning_\d+_/u.test(String(chunk.id)))
      .map((chunk) => [String(chunk.id).replace(/_[a-f0-9]{8}$/u, ""), chunk.title]),
  );
  expect(continuationTitles[0]).toEqual(["reasoning_20", `🧠 ${held} ${rest}`]);
  expect(reasoningIdsOf(second)).toEqual(Array.from({ length: 11 }, (_, index) => index + 20));
  for (const [index, segment] of segments.slice(19, 29).entries()) {
    expect(continuationTitles).toContainEqual([`reasoning_${index + 21}`, `🧠 ${segment}`]);
  }
  // The rolled message never received the extension: only the rejected
  // append and the rejected stop carried it.
  expect(
    first.filter(
      (call) =>
        call !== first[2] &&
        call !== first[3] &&
        chunksOf(call.params).some((c) => c.title === `🧠 ${held} ${rest}`),
    ),
  ).toHaveLength(0);
  expect(second.some((call) => call.params.text === `\n${FINAL_REPLY_TEXT}`)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("carries a rejected same-title tool-row update to the continuation", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 30 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const snapshotUpTo = (count: number) => ({
    kind: "reasoning" as const,
    text: segments.slice(0, count).join(" "),
    isReasoningSnapshot: true,
  });
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  const toolRow = (status: "in_progress" | "complete") =>
    taskUpdate(expect.stringMatching(/^tool_call_1_[a-f0-9]{8}$/u), "Bash", status);
  let rejectedStopChunks: Array<Record<string, unknown>> = [];
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      snapshotUpTo(20),
      {
        kind: "item",
        itemId: "tool:call-1",
        toolCallId: "call-1",
        itemKind: "command",
        name: "bash",
        phase: "update",
        status: "running",
        progressText: "install dependencies",
      },
      settle,
      {
        kind: "checkpoint",
        run: async () => {
          appendSlackStreamMock.mockRejectedValueOnce(new TestSlackStreamMessageTooLongError(""));
          stopSlackStreamMock.mockImplementationOnce(async (input) => {
            rejectedStopChunks = chunksOf(requireRecord(input, "stop"));
            throw new TestSlackStreamMessageTooLongError("");
          });
        },
      },
      // The tool finishes (same title, terminal status) and ten more cards
      // arrive; the append and then the rollover closeout carrying the
      // finished row are rejected.
      {
        kind: "command_output",
        itemId: "tool:call-1",
        toolCallId: "call-1",
        name: "bash",
        phase: "end",
        exitCode: 0,
      },
      snapshotUpTo(30),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages).toHaveLength(2);
  const [first, second] = messages;
  if (!first || !second) {
    throw new Error("expected two stream messages");
  }
  expect(first.map((call) => call.kind)).toEqual(["start", "append", "append", "stop", "stop"]);
  expect(chunksOf(first[1]?.params ?? {})).toContainEqual(toolRow("in_progress"));
  expect(rejectedStopChunks).toContainEqual(toolRow("complete"));
  // The rolled message never learned the tool finished; the continuation does,
  // and the turn's completion there has nothing left to terminalize.
  expect(
    first.filter(
      (call) =>
        call !== first[2] &&
        call !== first[3] &&
        chunksOf(call.params).some((c) => c.status === "complete" && c.title === "Bash"),
    ),
  ).toHaveLength(0);
  expect(chunksOf(second[0]?.params ?? {})).toContainEqual(toolRow("complete"));
  const toolStatusesOnContinuation = second.flatMap((call) =>
    chunksOf(call.params)
      .filter((chunk) => chunk.type === "task_update" && chunk.title === "Bash")
      .map((chunk) => chunk.status),
  );
  expect(toolStatusesOnContinuation).toEqual(["complete"]);
  expect(reasoningIdsOf(second)).toEqual(Array.from({ length: 11 }, (_, index) => index + 20));
  expect(second.some((call) => call.params.text === `\n${FINAL_REPLY_TEXT}`)).toBe(true);
  expect(second.at(-1)?.kind).toBe("stop");
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it.each([
  { terminal: "error", finalPayload: { text: "it broke", isError: true }, status: "error" },
  {
    terminal: "media",
    finalPayload: { text: "see the chart", mediaUrl: "https://example.com/chart.png" },
    status: "complete",
  },
  { terminal: "silent", finalPayload: undefined, status: "complete" },
] as const)(
  "drains queued cards through budgeted messages before a $terminal closeout",
  async ({ finalPayload, status }) => {
    vi.useFakeTimers();
    useFreshStreamSessions();
    const segments = Array.from({ length: 70 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
    await dispatchNativeProgressScenario({
      finalPayload,
      progress: { nativeTaskCards: true, reasoning: "cards" },
      // The burst is still queued behind the pacing loop when the turn ends.
      events: [{ kind: "reasoning", text: segments.join(" "), isReasoningSnapshot: true }],
    });

    const timeline = collectNativeStreamTimeline();
    const messages = splitNativeStreamMessages(timeline);
    const perMessageIds = messages.map((message) => reasoningIdsOf(message));
    expect(perMessageIds.flat()).toEqual(Array.from({ length: 70 }, (_, index) => index + 1));
    expect(messages).toHaveLength(3);
    for (const ids of perMessageIds) {
      expect(ids.length).toBeLessThanOrEqual(24);
    }
    // The turn's real status lands on the message current at the end.
    const last = messages.at(-1);
    expect(last?.at(-1)?.kind).toBe("stop");
    expect(last?.flatMap((call) => chunksOf(call.params))).toContainEqual(
      taskUpdate(
        expect.stringMatching(/^reasoning_70_[a-f0-9]{8}$/u),
        `🧠 ${segments[69]}`,
        status,
      ),
    );
    expect(deliverRepliesMock).toHaveBeenCalledTimes(finalPayload ? 1 : 0);
  },
);

it("carries a rejected completion to the message that streams the separate answer", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 24 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const answer = "a".repeat(3_300);
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: answer },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      { kind: "reasoning", text: segments.join(" "), isReasoningSnapshot: true },
      settle,
      { kind: "reasoning_end" },
      settle,
      {
        kind: "checkpoint",
        run: async () => {
          // The think's closeout (its summary title) is rejected when the message is finished for the answer.
          stopSlackStreamMock.mockRejectedValueOnce(new TestSlackStreamMessageTooLongError(""));
        },
      },
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages).toHaveLength(2);
  const [think, reply] = messages;
  if (!think || !reply) {
    throw new Error("expected two stream messages");
  }
  expect(think.slice(-2).map((call) => call.kind)).toEqual(["stop", "stop"]);
  expect(chunksOf(think.at(-2)?.params ?? {})).toContainEqual(
    planUpdate(expect.stringMatching(/^Thought for \d+s$/u)),
  );
  expect(think.at(-1)?.params.chunks).toBeUndefined();
  // The rejected closeout opens the message that carries the answer.
  expect(reply.map((call) => call.kind)).toEqual(["start", "append", "stop"]);
  expect(reply[0]?.params.taskDisplayMode).toBe("plan");
  expect(chunksOf(reply[0]?.params ?? {})).toContainEqual(
    planUpdate(expect.stringMatching(/^Thought for \d+s$/u)),
  );
  expect(reply[1]?.params.text).toBe(`\n${answer}`);
  expect(planTitlesOf(reply).filter((title) => title.startsWith("Thought for"))).toHaveLength(1);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("keeps a tool that is still running across a rollover until its result arrives", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 30 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      { kind: "reasoning", text: segments.slice(0, 20).join(" "), isReasoningSnapshot: true },
      settle,
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      settle,
      // Ten more cards roll the message while the tool is still running.
      { kind: "reasoning", text: segments.slice(20, 30).join(" "), isReasoningSnapshot: true },
      settle,
      // The tool fails after the rollover.
      { kind: "command_output", itemId: "tool-1", name: "bash", phase: "end", exitCode: 1 },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages).toHaveLength(2);
  const [first, second] = messages;
  if (!first || !second) {
    throw new Error("expected two stream messages");
  }
  const toolChunksOf = (message: NativeStreamCall[]) =>
    message.flatMap((call) =>
      chunksOf(call.params).filter(
        (chunk) => chunk.type === "task_update" && /^tool_1_[a-f0-9]{8}$/u.test(String(chunk.id)),
      ),
    );
  // Closing the message paints the running row complete there, but does not finish the tool.
  expect(chunksOf(first.at(-1)?.params ?? {})).toContainEqual(
    taskUpdate(expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u), "Bash", "complete"),
  );
  // The continuation carries the running row, receives its failure, and settles it at completion.
  const continuationStatuses = toolChunksOf(second).map((chunk) => chunk.status);
  expect(continuationStatuses[0]).toBe("in_progress");
  expect(continuationStatuses).toContain("error");
  expect(toolChunksOf(second).at(-1)).toEqual(
    taskUpdate(
      expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u),
      expect.stringMatching(/^Recovered: /u),
      "complete",
    ),
  );
  expect(reasoningIdsOf(second)).toEqual([25, 26, 27, 28, 29, 30]);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it.each([
  { how: "by size", narration: "n".repeat(8_800), rejectOnce: false },
  { how: "after msg_too_long", narration: "n".repeat(1_000), rejectOnce: true },
])(
  "opens the narration continuation within budget and delivers the queued cards later ($how)",
  async ({ narration, rejectOnce }) => {
    vi.useFakeTimers();
    useFreshStreamSessions();
    const segments = Array.from({ length: 60 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
    const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
    if (rejectOnce) {
      let rejected = false;
      appendSlackStreamMock.mockImplementation(async (input?: unknown) => {
        const params = requireRecord(input, "append");
        if (!rejected && params.text === narration) {
          rejected = true;
          requireRecord(params.session, "session").pendingText = narration;
          throw new TestSlackStreamMessageTooLongError(narration);
        }
      });
    }
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      progress: { nativeTaskCards: true, reasoning: "cards" },
      // 60 cards inside one throttle window, then a text payload the current message cannot take.
      events: [{ kind: "reasoning", text: segments.join(" "), isReasoningSnapshot: true }],
      replies: [{ kind: "block", payload: { text: narration } }],
    });
    await settle.run();

    const timeline = collectNativeStreamTimeline();
    const messages = splitNativeStreamMessages(timeline);
    const perMessageIds = messages.map((message) => reasoningIdsOf(message));
    // Every card arrives once, in order, and no message takes more than the row budget allows.
    expect(perMessageIds.flat()).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    for (const ids of perMessageIds) {
      expect(ids.length).toBeLessThanOrEqual(24);
    }
    // The narration lands once, on the message opened for it (after the
    // rejected append on the first one, when Slack rejected), never on a stop.
    const carrying = timeline.filter(
      (call) => call.kind !== "stop" && call.params.text === narration,
    );
    expect(carrying.every((call) => call.kind === "append")).toBe(true);
    expect(
      messages.flatMap((message, index) =>
        message.some((call) => call.kind === "append" && call.params.text === narration)
          ? [index]
          : [],
      ),
    ).toEqual(rejectOnce ? [0, 1] : [1]);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  },
);

it.each([
  { terminal: "error", finalPayload: { text: "it broke", isError: true }, status: "error" },
  {
    terminal: "media",
    finalPayload: { text: "see the chart", mediaUrl: "https://example.com/chart.png" },
    status: "complete",
  },
] as const)(
  "drains a 400-card queue through budgeted messages before a $terminal closeout",
  async ({ finalPayload, status }) => {
    vi.useFakeTimers();
    useFreshStreamSessions();
    const segments = Array.from({ length: 400 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
    await dispatchNativeProgressScenario({
      finalPayload,
      progress: { nativeTaskCards: true, reasoning: "cards" },
      events: [{ kind: "reasoning", text: segments.join(" "), isReasoningSnapshot: true }],
    });

    const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
    const perMessageIds = messages.map((message) => reasoningIdsOf(message));
    expect(perMessageIds.flat()).toEqual(Array.from({ length: 400 }, (_, index) => index + 1));
    expect(messages.length).toBeGreaterThanOrEqual(17);
    for (const ids of perMessageIds) {
      expect(ids.length).toBeLessThanOrEqual(24);
    }
    const last = messages.at(-1);
    expect(last?.at(-1)?.kind).toBe("stop");
    expect(last?.flatMap((call) => chunksOf(call.params))).toContainEqual(
      taskUpdate(
        expect.stringMatching(/^reasoning_400_[a-f0-9]{8}$/u),
        `🧠 ${segments[399]}`,
        status,
      ),
    );
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  },
);
