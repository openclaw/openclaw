import { expect, it, vi } from "vitest";
import { planUpdate, taskUpdate } from "./dispatch.compact-progress.test-support.js";
import {
  appendSlackStreamMock,
  chunksOf,
  collectNativeStreamTimeline,
  deliverRepliesMock,
  dispatchNativeProgressScenario,
  expectDeliverReplyCall,
  expectNativeStreamText,
  FINAL_REPLY_TEXT,
  type NativeStreamCall,
  harness,
  planTitlesOf,
  reasoningIdsOf,
  sleepRealMs,
  splitNativeStreamMessages,
  startSlackStreamMock,
  stopSlackStreamMock,
  TestSlackStreamMessageTooLongError,
  TestSlackStreamNotDeliveredError,
  THREAD_TS,
  useFreshStreamSessions,
} from "./dispatch.native-stream.test-support.js";
import { requireRecord } from "./dispatch.preview.test-support.js";

// The closeout and the answer at the end of a reasoning-card chain.

it("drains tool rows the compositor admitted past the budget before an error closeout", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  // 120 distinct tool rows inside one throttle window: the first message
  // and each continuation take a budget's worth, so a fresh opening still
  // has to defer rows.
  const toolStarts = Array.from({ length: 120 }, (_, index) => ({
    kind: "tool_start" as const,
    itemId: `tool-${index + 1}`,
    name: "bash",
    phase: "start" as const,
    args: { command: `pnpm test --filter case-${index + 1} ${"x".repeat(60)}` },
  }));
  await dispatchNativeProgressScenario({
    finalPayload: { text: "it broke", isError: true },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: toolStarts,
  });

  const timeline = collectNativeStreamTimeline();
  const messages = splitNativeStreamMessages(timeline);
  const toolIdsOf = (calls: NativeStreamCall[]) => [
    ...new Set(
      calls.flatMap((call) =>
        chunksOf(call.params)
          .filter((chunk) => chunk.type === "task_update" && /^tool_\d+_/u.test(String(chunk.id)))
          .map((chunk) => Number(/^tool_(\d+)_/u.exec(String(chunk.id))?.[1])),
      ),
    ),
  ];
  // Every tool row reaches Slack once, on budgeted messages, with the error status at the end.
  expect(toolIdsOf(timeline).toSorted((a, b) => a - b)).toEqual(
    Array.from({ length: 120 }, (_, index) => index + 1),
  );
  expect(messages.length).toBeGreaterThanOrEqual(3);
  const perMessage = messages.map((message) => toolIdsOf(message));
  expect(perMessage.flat()).toHaveLength(120);
  const last = messages.at(-1);
  expect(last?.at(-1)?.kind).toBe("stop");
  expect(
    last?.flatMap((call) => chunksOf(call.params)).some((chunk) => chunk.status === "error"),
  ).toBe(true);
  expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
});

it("leaves continuation capacity for queued cards behind a plan that fills the row budget", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 30 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      {
        kind: "plan",
        phase: "update",
        steps: Array.from({ length: 50 }, (_, index) => ({
          step: `Step ${index + 1}`,
          status: "pending" as const,
        })),
      },
      { kind: "reasoning", text: segments.join(" "), isReasoningSnapshot: true },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  const perMessageIds = messages.map((message) => reasoningIdsOf(message));
  // The plan alone fills the first message; every continuation carries cards,
  // and the run converges with each card delivered once.
  expect(perMessageIds.flat()).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  expect(messages.length).toBeGreaterThanOrEqual(2);
  expect(messages.length).toBeLessThanOrEqual(4);
  for (const ids of perMessageIds.slice(1)) {
    expect(ids.length).toBeGreaterThan(0);
  }
  const last = messages.at(-1);
  expect(last?.some((call) => call.params.text === `\n${FINAL_REPLY_TEXT}`)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("keeps plan progress visible across budgeted continuations and settles it at completion", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 30 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  const plan = (inProgress: number) =>
    Array.from({ length: 50 }, (_, index) => ({
      step: `Step ${index + 1}`,
      status:
        index + 1 < inProgress
          ? ("completed" as const)
          : index + 1 === inProgress
            ? ("in_progress" as const)
            : ("pending" as const),
    }));
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      { kind: "plan", phase: "update", steps: plan(1) },
      { kind: "reasoning", text: segments.join(" "), isReasoningSnapshot: true },
      settle,
      // Step 1 finishes and step 2 starts while the cards are still going out.
      { kind: "plan", phase: "update", steps: plan(2) },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages.length).toBeGreaterThanOrEqual(2);
  const planStatuses = (calls: NativeStreamCall[], step: number) =>
    calls.flatMap((call) =>
      chunksOf(call.params)
        .filter((chunk) => chunk.type === "task_update" && chunk.id === `plan_step_${step}`)
        .map((chunk) => chunk.status),
    );
  const second = messages[1] as NativeStreamCall[];
  const last = messages.at(-1) as NativeStreamCall[];
  // The running step opens every continuation; the burst drains through the
  // continuations within the first paced send, so the plan update lands on
  // the message current then, the last one, and the completion settles the
  // step that was running at the end.
  expect(planStatuses(second, 1)[0]).toBe("in_progress");
  expect(planStatuses(last, 1)[0]).toBe("in_progress");
  expect(planStatuses(last, 1)).toContain("complete");
  expect(planStatuses(last, 2)).toContain("in_progress");
  expect(planStatuses(last, 2).at(-1)).toBe("complete");
  expect(messages.flatMap((message) => reasoningIdsOf(message))).toEqual(
    Array.from({ length: 30 }, (_, index) => index + 1),
  );
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("delivers a later result for a running row frozen by an overflow roll", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  const toolStarts = Array.from({ length: 120 }, (_, index) => ({
    kind: "tool_start" as const,
    itemId: `tool-${index + 1}`,
    name: "bash",
    phase: "start" as const,
    args: { command: `pnpm test --filter case-${index + 1}` },
  }));
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      ...toolStarts,
      // The burst rolls through several messages; the running rows of a
      // rolled message are frozen there.
      settle,
      // The first tool, on the first message, fails afterwards.
      { kind: "command_output", itemId: "tool-1", name: "bash", phase: "end", exitCode: 1 },
      settle,
    ],
  });

  const timeline = collectNativeStreamTimeline();
  const messages = splitNativeStreamMessages(timeline);
  expect(messages.length).toBeGreaterThanOrEqual(3);
  const tool1 = (calls: NativeStreamCall[]) =>
    calls.flatMap((call) =>
      chunksOf(call.params).filter(
        (chunk) => chunk.type === "task_update" && /^tool_1_[a-f0-9]{8}$/u.test(String(chunk.id)),
      ),
    );
  const first = messages[0] as NativeStreamCall[];
  const last = messages.at(-1) as NativeStreamCall[];
  // The first message closed with the row painted complete (the message overflowed).
  expect(tool1(first).at(-1)?.status).toBe("complete");
  // The failure reaches the current message and the completion settles it there.
  expect(tool1(last).map((chunk) => chunk.status)).toContain("error");
  expect(tool1(last).at(-1)).toEqual(
    taskUpdate(
      expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u),
      expect.stringMatching(/^Recovered: /u),
      "complete",
    ),
  );
  expect(last.some((call) => call.params.text === `\n${FINAL_REPLY_TEXT}`)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("keeps a tool row behind the reasoning cards queued before it", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const segments = Array.from({ length: 60 }, (_, index) => `s${index + 1}`.padEnd(240, "x"));
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      // 60 cards queue beyond the current message; the tool starts before the next paced send.
      { kind: "reasoning", text: segments.join(" "), isReasoningSnapshot: true },
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const timeline = collectNativeStreamTimeline();
  // First appearance of every row, in transport order: the reasoning that
  // preceded the tool call comes first, on every message it needs.
  const order: string[] = [];
  for (const call of timeline) {
    for (const chunk of chunksOf(call.params)) {
      if (chunk.type !== "task_update" || typeof chunk.id !== "string") {
        continue;
      }
      const id = chunk.id.replace(/_[a-f0-9]{8}$/u, "");
      if (!order.includes(id)) {
        order.push(id);
      }
    }
  }
  expect(order).toEqual([
    ...Array.from({ length: 60 }, (_, index) => `reasoning_${index + 1}`),
    "tool_1",
  ]);
  const messages = splitNativeStreamMessages(timeline);
  expect(messages.flatMap((message) => reasoningIdsOf(message))).toEqual(
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("sends commentary rejected together with a card update once, on the continuation", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const commentary = "Let me check the handler.";
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  let pendingTextAtRollStop: unknown = "unset";
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards", commentary: true },
    events: [
      { kind: "reasoning", text: "Plan the fix." },
      settle,
      { kind: "reasoning_end" },
      {
        kind: "checkpoint",
        run: async () => {
          // Slack rejects the batch; the SDK keeps its text in the buffer, as
          // the real streamer does after a failed flush.
          appendSlackStreamMock.mockImplementationOnce(async (input) => {
            const params = requireRecord(input, "append");
            const text = typeof params.text === "string" ? params.text : "";
            requireRecord(params.session, "session").pendingText = text;
            throw new TestSlackStreamMessageTooLongError(text);
          });
          stopSlackStreamMock.mockImplementationOnce(async (input) => {
            pendingTextAtRollStop = requireRecord(
              requireRecord(input, "stop").session,
              "session",
            ).pendingText;
            return {};
          });
        },
      },
      { kind: "item", itemKind: "preamble", itemId: "preamble-1", progressText: commentary },
      { kind: "reasoning", text: "Then test it." },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const timeline = collectNativeStreamTimeline();
  const messages = splitNativeStreamMessages(timeline);
  expect(messages).toHaveLength(2);
  const [first, second] = messages;
  if (!first || !second) {
    throw new Error("expected two stream messages");
  }
  // The rolled message's stop flushes nothing the SDK retained from the rejected batch.
  expect(pendingTextAtRollStop).toBe("");
  expect(first.at(-1)?.kind).toBe("stop");
  expect(chunksOf(first.at(-1)?.params ?? {}).some((chunk) => chunk.type === "markdown_text")).toBe(
    false,
  );
  // Apart from the rejected append, the commentary reaches Slack exactly
  // once, on the continuation's start, and never on the rolled message.
  const carries = (call: NativeStreamCall) =>
    typeof call.params.text === "string" && call.params.text.includes(commentary);
  const rejectedAppend = first.at(-2);
  expect(rejectedAppend?.kind).toBe("append");
  expect(rejectedAppend && carries(rejectedAppend)).toBe(true);
  expect(first.filter((call) => call !== rejectedAppend && carries(call))).toHaveLength(0);
  expect(second.filter(carries)).toEqual([second[0]]);
  expect(second[0]?.kind).toBe("start");
  expect(reasoningIdsOf(second)).toEqual([2]);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("does not open a continuation or post the answer after a Slack Stop lands during the rollover", async () => {
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
          // Slack's Stop for this message is admitted while the rollover stop is in flight.
          stopSlackStreamMock.mockImplementationOnce(async (input) => {
            const session = requireRecord(requireRecord(input, "stop").session, "session");
            session.stopped = true;
            session.stoppedBySlack = true;
            return {};
          });
        },
      },
      snapshotUpTo(30),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const timeline = collectNativeStreamTimeline();
  expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
  // Nothing is written after the stopped message: no continuation, no completion, no answer.
  expect(timeline.at(-1)?.kind).toBe("stop");
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`, 0);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("stops the stream and delivers the answer normally when the continuation is rejected too", async () => {
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
          startSlackStreamMock.mockRejectedValueOnce(new TestSlackStreamMessageTooLongError(""));
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
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const timeline = collectNativeStreamTimeline();
  expect(timeline.map((call) => call.kind)).toEqual(["start", "append", "stop", "start"]);
  expect(chunksOf(timeline[2]?.params ?? {})[0]).toEqual(planUpdate("Thinking, continued below"));
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
});

it("streams the answer as its own message when Slack rejects it with msg_too_long", async () => {
  useFreshStreamSessions();
  appendSlackStreamMock.mockImplementation(async (input?: unknown) => {
    const params = requireRecord(input, "append");
    if (params.text === `\n${FINAL_REPLY_TEXT}` && appendSlackStreamMock.mock.calls.length < 3) {
      throw new TestSlackStreamMessageTooLongError(params.text);
    }
  });
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [{ kind: "reasoning", text: "Checking the handler" }, { kind: "reasoning_end" }],
  });

  const timeline = collectNativeStreamTimeline();
  expect(timeline.map((call) => call.kind)).toEqual([
    "start",
    "append",
    "append",
    "stop",
    "start",
    "stop",
  ]);
  // The think closed normally on the first message before the answer was rejected.
  expect(chunksOf(timeline[1]?.params ?? {})[0]).toEqual(
    planUpdate(expect.stringMatching(/^Thought for \d+s$/u)),
  );
  expect(timeline[2]?.params.text).toBe(`\n${FINAL_REPLY_TEXT}`);
  expect(timeline[3]?.params.chunks).toBeUndefined();
  // The retry is a text-only stream in the same thread.
  expect(timeline[4]?.params).toMatchObject({
    threadTs: THREAD_TS,
    text: FINAL_REPLY_TEXT,
    chunks: [],
  });
  expect(timeline[4]?.params.taskDisplayMode).toBeUndefined();
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it.each([
  {
    rejection: "msg_too_long",
    error: () => new TestSlackStreamMessageTooLongError(FINAL_REPLY_TEXT),
  },
  {
    // The retry's start never got a message ts, so there is no stream to stop.
    rejection: "a definite start rejection",
    error: () =>
      new TestSlackStreamNotDeliveredError(FINAL_REPLY_TEXT, "channel_type_not_supported"),
  },
])(
  "delivers the answer normally when its retry as a new message hits $rejection",
  async ({ error }) => {
    useFreshStreamSessions();
    appendSlackStreamMock.mockImplementation(async (input?: unknown) => {
      const params = requireRecord(input, "append");
      if (params.text === `\n${FINAL_REPLY_TEXT}`) {
        throw new TestSlackStreamMessageTooLongError(params.text);
      }
    });
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      progress: { nativeTaskCards: true, reasoning: "cards" },
      events: [
        { kind: "reasoning", text: "Checking the handler" },
        {
          kind: "checkpoint",
          run: async () => {
            startSlackStreamMock.mockRejectedValueOnce(error());
          },
        },
        { kind: "reasoning_end" },
      ],
    });

    const timeline = collectNativeStreamTimeline();
    expect(timeline.map((call) => call.kind)).toEqual([
      "start",
      "append",
      "append",
      "stop",
      "start",
    ]);
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  },
);

it("finishes the think and streams a long answer separately when both would not fit one message", async () => {
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
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages).toHaveLength(2);
  const [think, reply] = messages;
  if (!think || !reply) {
    throw new Error("expected two stream messages");
  }
  expect(reasoningIdsOf(think)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
  // The think closes with its summary title; the answer is not squeezed under it.
  const stop = think.at(-1);
  expect(stop?.kind).toBe("stop");
  expect(chunksOf(stop?.params ?? {})).toContainEqual(
    planUpdate(expect.stringMatching(/^Thought for \d+s$/u)),
  );
  expect(think.some((call) => call.params.text === `\n${answer}`)).toBe(false);
  expect(reply.map((call) => call.kind)).toEqual(["start", "stop"]);
  expect(reply[0]?.params).toMatchObject({ threadTs: THREAD_TS, text: answer, chunks: [] });
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("keeps a fitting answer on the card message when the draft boundary lands during final delivery", async () => {
  // Real event order from a live model: thinking deltas, then the assistant text; core fires
  // onReasoningEnd and onAssistantMessageStart best effort (not awaited) while the seal's
  // append is still in flight, and the final reply is dispatched right behind them.
  const realSecond = {
    kind: "checkpoint" as const,
    run: () => sleepRealMs(1_050),
  };
  // Slack round trips take time; a stop returns a little faster than an append.
  appendSlackStreamMock.mockImplementation(async () => {
    await sleepRealMs(10);
  });
  stopSlackStreamMock.mockImplementation(async () => {
    await sleepRealMs(5);
    return {};
  });
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      { kind: "reasoning", text: "The user wants a short answer.", isReasoningSnapshot: true },
      realSecond,
      {
        kind: "reasoning",
        text: "The user wants a short answer. Keep it short and Slack formatted.",
        isReasoningSnapshot: true,
      },
      realSecond,
      {
        kind: "checkpoint",
        run: async () => {
          // The seal's append is still in flight when the run ends.
          appendSlackStreamMock.mockImplementationOnce(async () => {
            await sleepRealMs(30);
          });
          void harness.capturedReplyOptions?.onReasoningEnd?.();
          void harness.capturedReplyOptions?.onAssistantMessageStart?.();
        },
      },
    ],
  });
  // The late boundary settles after the dispatch returns.
  await sleepRealMs(60);

  const timeline = collectNativeStreamTimeline();
  expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
  expect(timeline.map((call) => call.kind)).toEqual([
    "start",
    "append",
    "append",
    "append",
    "append",
    "stop",
  ]);
  expect(planTitlesOf(timeline).at(-1)).toMatch(/^Thought for \d+s$/u);
  expect(timeline[4]?.params.text).toBe(`\n${FINAL_REPLY_TEXT}`);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("titles the finished think with its summary even when a preamble headline was showing", async () => {
  vi.useFakeTimers();
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  const preamble =
    "The full-home scan was too slow — let me grab random files from a shallower sweep instead.";
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards" },
    events: [
      { kind: "reasoning", text: "The find command got terminated.", isReasoningSnapshot: true },
      settle,
      { kind: "item", itemKind: "preamble", itemId: "preamble-1", progressText: preamble },
      settle,
      { kind: "reasoning", text: "Six random files it is.", isReasoningSnapshot: true },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const titles = planTitlesOf(collectNativeStreamTimeline());
  // The headline may show while the turn runs, but the finished card is the think's summary.
  expect(titles).toContain(preamble);
  expect(titles.at(-1)).toMatch(/^Thought for \d+s$/u);
  expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
});

it("opens a text-only continuation with explicit empty chunks so Slack acknowledges it", async () => {
  vi.useFakeTimers();
  useFreshStreamSessions();
  const commentary = "Let me check the handler.";
  const settle = { kind: "checkpoint" as const, run: () => vi.advanceTimersByTimeAsync(1_000) };
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { nativeTaskCards: true, reasoning: "cards", commentary: true },
    events: [
      { kind: "reasoning", text: "Plan the fix." },
      settle,
      { kind: "reasoning_end" },
      {
        kind: "checkpoint",
        run: async () => {
          appendSlackStreamMock.mockRejectedValueOnce(new TestSlackStreamMessageTooLongError(""));
        },
      },
      { kind: "item", itemKind: "preamble", itemId: "preamble-1", progressText: commentary },
      settle,
    ],
  });

  const messages = splitNativeStreamMessages(collectNativeStreamTimeline());
  expect(messages).toHaveLength(2);
  // Text alone would sit in the SDK buffer and Slack would never see the start.
  const opening = messages[1]?.[0];
  expect(opening?.kind).toBe("start");
  expect(opening?.params.text).toContain(commentary);
  expect(opening?.params.chunks).toEqual([]);
});
