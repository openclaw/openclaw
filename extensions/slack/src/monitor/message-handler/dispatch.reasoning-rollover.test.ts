import { expect, it, vi } from "vitest";
import {
  planUpdate,
  requireMockCall,
  taskUpdate,
  toolStart,
} from "./dispatch.compact-progress.test-support.js";
import {
  appendSlackStreamMock,
  CARDS_PER_MESSAGE,
  cardSegments,
  carriesText,
  chunksOf,
  collectNativeStreamTimeline,
  deliverRepliesMock,
  dispatchCardsScenario,
  expectCardsOnceWithinBudget,
  expectStreamMessages,
  FINAL_REPLY_TEXT,
  type NativeStreamCall,
  planTitlesOf,
  range,
  reasoningIdsOf,
  reasoningSnapshot,
  rejectAppendAndRolloverStop,
  rejectNextWithMsgTooLong,
  settle,
  splitNativeStreamMessages,
  startSlackStreamMock,
  stopSlackStreamMock,
  taskRowsOf,
  TestSlackStreamMessageTooLongError,
  THREAD_TS,
} from "./dispatch.native-stream.test-support.js";
import { requireRecord } from "./dispatch.preview.test-support.js";

// Native progress turns that outgrow or outlive one streamed message continue in new messages.

const bashStart = toolStart({ command: "pnpm test" }, { itemId: "tool-1" });
const toolRowId = expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u);

it("rolls a long think into continuation messages, each under the per-message budget", async () => {
  const segments = cardSegments(50);
  const snapshot = (from: number, to: number) =>
    reasoningSnapshot(segments.slice(from, to).join(" "));
  await dispatchCardsScenario({
    events: [
      snapshot(0, 10),
      settle,
      snapshot(0, 20),
      settle,
      bashStart,
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

  const timeline = collectNativeStreamTimeline();
  // 21 cards fit the row budget (CARDS_PER_MESSAGE); 50 cards need three messages.
  const [first = [], second = [], third = []] = expectStreamMessages(3);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(3);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
  // Every segment appears exactly once, in order, and no card is on two messages.
  const perMessageIds = expectCardsOnceWithinBudget([first, second, third], 50);
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
      expect(chunk).toMatchObject({ type: "task_update", status: "complete" });
    }
    expect(planTitlesOf(rolled)).not.toContainEqual(expect.stringMatching(/^Thought for/u));
    expect(carriesText(rolled)).toBe(false);
  }
  // The tool never reports a result here, so it is still running when each
  // message rolls: painted complete on the rolled message (closing it), carried
  // to the next one, and settled by the turn's completion on the last.
  expect(chunksOf(first.at(-1)?.params ?? {})).toContainEqual(
    taskUpdate(toolRowId, "Bash", "complete"),
  );
  expect(taskRowsOf(second, /^tool_1$/u)).not.toHaveLength(0);
  expect(chunksOf(third[0]?.params ?? {})).toContainEqual(
    taskUpdate(toolRowId, "Bash", "in_progress"),
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
      expect.arrayContaining([toolRowId, expect.stringMatching(/^reasoning_\d+_[a-f0-9]{8}$/u)]),
    );
  }

  // The answer and the summary title land on the message that is current at the end.
  expect(planTitlesOf(third).at(-1)).toBe("Thought for 7s, 1 tool call");
  expect(carriesText(third)).toBe(true);
  expect(third.at(-1)?.kind).toBe("stop");
  expect(chunksOf(third.at(-1)?.params ?? {})).toEqual([]);
  for (const chunk of timeline.flatMap((call) => chunksOf(call.params))) {
    if (chunk.type === "task_update") {
      expect(String(chunk.title).length).toBeLessThanOrEqual(250);
    }
  }
  expect(planTitlesOf(timeline)).not.toContainEqual(expect.stringContaining("🧠"));
});

it("rolls the quiet card's reasoning rows into continuations without tool rows", async () => {
  const segments = cardSegments(50);
  await dispatchCardsScenario({
    progress: { style: "card", toolProgress: false },
    events: [
      reasoningSnapshot(segments.slice(0, 20).join(" ")),
      settle,
      bashStart,
      settle,
      reasoningSnapshot(segments.slice(20, 50).join(" ")),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const messages = expectStreamMessages(3);
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(3);
  expectCardsOnceWithinBudget(messages, 50);
  for (const message of messages) {
    // The summary row is the turn's own row: every message shows it, and no tool row.
    expect(chunksOf(message[0]?.params ?? {})[1]).toMatchObject({ id: "openclaw_summary" });
    expect(taskRowsOf(message, /^tool_\d+$/u)).toEqual([]);
  }
  expect(planTitlesOf(messages[0] ?? []).at(-1)).toBe("Thinking, continued below");
  // The quiet card keeps its own headline; the answer lands on the last message.
  expect(planTitlesOf(messages[2] ?? []).at(-1)).toBe("Completed");
  expect(carriesText(messages[2] ?? [])).toBe(true);
});

it("rolls to a continuation and retries once when Slack rejects a card update with msg_too_long", async () => {
  await dispatchCardsScenario({
    events: [
      { kind: "reasoning", text: "Plan the fix." },
      settle,
      rejectNextWithMsgTooLong(appendSlackStreamMock),
      bashStart,
      settle,
      { kind: "reasoning", text: "Tests pass, now summarize." },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const [first = [], second = []] = expectStreamMessages(2);
  // The rejected append (the card sealed by the tool call) is followed by
  // the rolled stop, nothing else on that message.
  const card1 = taskUpdate(
    expect.stringMatching(/^reasoning_1_[a-f0-9]{8}$/u),
    "🧠 Plan the fix.",
    "complete",
  );
  expect(first.map((call) => call.kind)).toEqual(["start", "append", "stop"]);
  expect(chunksOf(first[1]?.params ?? {})).toEqual([card1]);
  expect(chunksOf(first[2]?.params ?? {})).toEqual([
    planUpdate("Thinking, continued below"),
    card1,
  ]);
  // The retry carries the rejected rows to the continuation; the turn finishes there.
  expect(second[0]?.params).toMatchObject({ threadTs: THREAD_TS, taskDisplayMode: "plan" });
  expect(chunksOf(second[0]?.params ?? {})).toEqual([
    planUpdate("Bash"),
    taskUpdate(toolRowId, "Bash", "in_progress"),
  ]);
  expect(reasoningIdsOf(second)).toEqual([2]);
  expect(planTitlesOf(second).at(-1)).toMatch(/^Thought for \d+s, 1 tool call$/u);
  expect(carriesText(second)).toBe(true);
  expect(second.at(-1)?.kind).toBe("stop");
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("delivers every card of a burst wider than a rolling window, once and in order", async () => {
  const segments = cardSegments(70);
  await dispatchCardsScenario({
    events: [
      // One cumulative snapshot admits 70 cards before the paced loop sends again.
      reasoningSnapshot(segments.join(" ")),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  // No segment is lost to the compositor before its first send, none is repeated.
  expectCardsOnceWithinBudget(expectStreamMessages(4), 70);
  for (const chunk of collectNativeStreamTimeline().flatMap((call) => chunksOf(call.params))) {
    const match = /^reasoning_(\d+)_[a-f0-9]{8}$/u.exec(String(chunk.id));
    if (match) {
      expect(chunk.title).toBe(`🧠 ${segments[Number(match[1]) - 1]}`);
    }
  }
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("carries closeout rows Slack rejected with msg_too_long to the continuation", async () => {
  const segments = cardSegments(30);
  await dispatchCardsScenario({
    events: [
      reasoningSnapshot(segments.slice(0, 17).join(" ")),
      settle,
      // Four of the new cards fit this message but Slack rejects the append
      // that carries them, and then the rollover stop as well.
      rejectNextWithMsgTooLong(appendSlackStreamMock, stopSlackStreamMock),
      reasoningSnapshot(segments.join(" ")),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const [first = [], second = []] = expectStreamMessages(2);
  // The rejected append carried the four cards, the rejected closeout the
  // completion of card 17; a stop without chunks ends that message.
  expect(first.map((call) => call.kind)).toEqual(["start", "append", "append", "stop", "stop"]);
  expect(reasoningIdsOf(first.slice(0, 2))).toEqual(range(1, 17));
  expect(reasoningIdsOf(first.slice(2, 3))).toEqual(expect.arrayContaining([18, 19, 20, 21]));
  expect(reasoningIdsOf(first.slice(3, 4))).toEqual([17]);
  expect(first[4]?.params.chunks).toBeUndefined();
  // Every card Slack did not take reaches the continuation's start in order:
  // the four in the rejected closeout, and card 17, whose completion the
  // closeout carried and Slack refused; the turn finishes there.
  expect(reasoningIdsOf(second)).toEqual(range(17, 30));
  expect(reasoningIdsOf(second.slice(0, 1))).toEqual(range(17, 30));
  expect(carriesText(second)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("carries the rejected extension of a partial card to the continuation", async () => {
  const segments = cardSegments(30);
  // Card 20 is "held" alone on the first message; its extension "held rest"
  // (226 bytes) still fits one card, and "rest" alone starts a card past a
  // word cut in the second half of the window.
  const held = "h".repeat(100);
  const rest = "t".repeat(125);
  const { checkpoint, rejected } = rejectAppendAndRolloverStop();
  await dispatchCardsScenario({
    events: [
      // Cards 1-19 complete, card 20 partial on the first message.
      reasoningSnapshot(`${segments.slice(0, 19).join(" ")} ${held}`),
      settle,
      checkpoint,
      // Card 20 grows and ten more cards arrive; the append and then the
      // rollover closeout carrying the extension are rejected, so Slack
      // keeps the shorter title.
      reasoningSnapshot(
        `${segments.slice(0, 19).join(" ")} ${held} ${rest} ${segments.slice(19, 29).join(" ")}`,
      ),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const [first = [], second = []] = expectStreamMessages(2);
  expect(first.map((call) => call.kind)).toEqual(["start", "append", "append", "stop", "stop"]);
  expect(rejected.stopChunks).toContainEqual(
    taskUpdate(
      expect.stringMatching(/^reasoning_20_[a-f0-9]{8}$/u),
      `🧠 ${held} ${rest}`,
      "complete",
    ),
  );
  // Slack holds only the short title for card 20, so the whole card, with the
  // text it never took, opens the continuation ahead of the deferred cards.
  const continuationTitles = taskRowsOf(second, /^reasoning_\d+$/u).map((chunk) => [
    String(chunk.id).replace(/_[a-f0-9]{8}$/u, ""),
    chunk.title,
  ]);
  expect(continuationTitles[0]).toEqual(["reasoning_20", `🧠 ${held} ${rest}`]);
  expect(reasoningIdsOf(second)).toEqual(range(20, 30));
  for (const [index, segment] of segments.slice(19, 29).entries()) {
    expect(continuationTitles).toContainEqual([`reasoning_${index + 21}`, `🧠 ${segment}`]);
  }
  // The rolled message never received the extension: only the rejected
  // append and the rejected stop carried it.
  const accepted = [first[0], first[1], first[4]] as NativeStreamCall[];
  expect(accepted.flatMap((call) => chunksOf(call.params))).not.toContainEqual(
    expect.objectContaining({ title: `🧠 ${held} ${rest}` }),
  );
  expect(carriesText(second)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("carries a rejected same-title tool-row update to the continuation", async () => {
  const segments = cardSegments(30);
  const toolRow = (status: "in_progress" | "complete") =>
    taskUpdate(expect.stringMatching(/^tool_call_1_[a-f0-9]{8}$/u), "Bash", status);
  const { checkpoint, rejected } = rejectAppendAndRolloverStop();
  await dispatchCardsScenario({
    events: [
      reasoningSnapshot(segments.slice(0, 20).join(" ")),
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
      checkpoint,
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
      reasoningSnapshot(segments.join(" ")),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const [first = [], second = []] = expectStreamMessages(2);
  expect(first.map((call) => call.kind)).toEqual(["start", "append", "append", "stop", "stop"]);
  expect(chunksOf(first[1]?.params ?? {})).toContainEqual(toolRow("in_progress"));
  expect(rejected.stopChunks).toContainEqual(toolRow("complete"));
  // The rolled message never learned the tool finished; the continuation does,
  // and the turn's completion there has nothing left to terminalize.
  const accepted = [first[0], first[1], first[4]] as NativeStreamCall[];
  expect(accepted.flatMap((call) => chunksOf(call.params))).not.toContainEqual(
    expect.objectContaining({ title: "Bash", status: "complete" }),
  );
  expect(chunksOf(second[0]?.params ?? {})).toContainEqual(toolRow("complete"));
  expect(taskRowsOf(second, /^tool_call_1$/u).map((chunk) => chunk.status)).toEqual(["complete"]);
  expect(reasoningIdsOf(second)).toEqual(range(20, 30));
  expect(carriesText(second)).toBe(true);
  expect(second.at(-1)?.kind).toBe("stop");
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

const errorEnd = { terminal: "error", finalPayload: { text: "it broke", isError: true } };
const mediaEnd = {
  terminal: "media",
  finalPayload: { text: "see the chart", mediaUrl: "https://example.com/chart.png" },
};
it.each([
  { cards: 70, ...errorEnd, status: "error" },
  { cards: 70, ...mediaEnd, status: "complete" },
  { cards: 70, terminal: "silent", finalPayload: undefined, status: "complete" },
  { cards: 400, ...errorEnd, status: "error" },
  { cards: 400, ...mediaEnd, status: "complete" },
] as const)(
  "drains $cards queued cards through budgeted messages before a $terminal closeout",
  async ({ cards, finalPayload, status }) => {
    const segments = cardSegments(cards);
    // The burst is still queued behind the pacing loop when the turn ends.
    await dispatchCardsScenario({ finalPayload, events: [reasoningSnapshot(segments.join(" "))] });

    const messages = expectStreamMessages();
    expectCardsOnceWithinBudget(messages, cards);
    expect(messages).toHaveLength(Math.ceil(cards / CARDS_PER_MESSAGE));
    // The turn's real status lands on the message current at the end.
    const last = messages.at(-1) ?? [];
    expect(last.at(-1)?.kind).toBe("stop");
    expect(taskRowsOf(last, new RegExp(`^reasoning_${cards}$`, "u"))).toContainEqual(
      taskUpdate(expect.any(String), `🧠 ${segments.at(-1)}`, status),
    );
    expect(deliverRepliesMock).toHaveBeenCalledTimes(finalPayload ? 1 : 0);
  },
);

it("carries a rejected completion to the message that streams the separate answer", async () => {
  const answer = "a".repeat(3_700);
  await dispatchCardsScenario({
    finalPayload: { text: answer },
    events: [
      reasoningSnapshot(cardSegments(CARDS_PER_MESSAGE).join(" ")),
      settle,
      { kind: "reasoning_end" },
      settle,
      // The think's closeout (its summary title) is rejected when the message is finished for the answer.
      rejectNextWithMsgTooLong(stopSlackStreamMock),
    ],
  });

  const [think = [], reply = []] = expectStreamMessages(2);
  const summary = planUpdate(expect.stringMatching(/^Thought for \d+s$/u));
  expect(think.slice(-2).map((call) => call.kind)).toEqual(["stop", "stop"]);
  expect(chunksOf(think.at(-2)?.params ?? {})).toContainEqual(summary);
  expect(think.at(-1)?.params.chunks).toBeUndefined();
  // The rejected closeout opens the message that carries the answer.
  expect(reply.map((call) => call.kind)).toEqual(["start", "append", "stop"]);
  expect(reply[0]?.params.taskDisplayMode).toBe("plan");
  expect(chunksOf(reply[0]?.params ?? {})).toContainEqual(summary);
  expect(reply[1]?.params.text).toBe(`\n${answer}`);
  expect(planTitlesOf(reply).filter((title) => title.startsWith("Thought for"))).toHaveLength(1);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("keeps a tool that is still running across a rollover until its result arrives", async () => {
  const segments = cardSegments(30);
  await dispatchCardsScenario({
    events: [
      reasoningSnapshot(segments.slice(0, 20).join(" ")),
      settle,
      bashStart,
      settle,
      // Ten more cards roll the message while the tool is still running.
      reasoningSnapshot(segments.slice(20, 30).join(" ")),
      settle,
      // The tool fails after the rollover.
      { kind: "command_output", itemId: "tool-1", name: "bash", phase: "end", exitCode: 1 },
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const [first = [], second = []] = expectStreamMessages(2);
  // Closing the message paints the running row complete there, but does not finish the tool.
  expect(chunksOf(first.at(-1)?.params ?? {})).toContainEqual(
    taskUpdate(toolRowId, "Bash", "complete"),
  );
  // The continuation carries the running row, receives its failure, and settles it at completion.
  const toolRows = taskRowsOf(second, /^tool_1$/u);
  expect(toolRows[0]?.status).toBe("in_progress");
  expect(toolRows.map((chunk) => chunk.status)).toContain("error");
  expect(toolRows.at(-1)).toEqual(
    taskUpdate(toolRowId, expect.stringMatching(/^Recovered: /u), "complete"),
  );
  expect(reasoningIdsOf(second)).toEqual(range(CARDS_PER_MESSAGE + 1, 30));
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it.each([
  { how: "by size", narration: "n".repeat(5_000), rejectOnce: false },
  { how: "after msg_too_long", narration: "n".repeat(1_000), rejectOnce: true },
])(
  "opens the narration continuation within budget and delivers the queued cards later ($how)",
  async ({ narration, rejectOnce }) => {
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
    await dispatchCardsScenario({
      // 20 cards on the first message, 40 more inside one throttle window, then
      // a text payload the current message cannot take.
      events: [
        reasoningSnapshot(cardSegments(20).join(" ")),
        settle,
        reasoningSnapshot(cardSegments(60).join(" ")),
      ],
      replies: [{ kind: "block", payload: { text: narration } }],
    });
    await settle.run();

    const timeline = collectNativeStreamTimeline();
    const messages = splitNativeStreamMessages(timeline);
    // Every card arrives once, in order, and no message takes more than the row budget allows.
    expectCardsOnceWithinBudget(messages, 60);
    // The narration lands once, on the message opened for it (after the
    // rejected append on the first one, when Slack rejected), never on a stop.
    const carrying = timeline.filter((call) => call.params.text === narration);
    expect(carrying.every((call) => call.kind === "append")).toBe(true);
    expect(
      messages.flatMap((message, index) => (carriesText(message, narration) ? [index] : [])),
    ).toEqual(rejectOnce ? [0, 1] : [1]);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  },
);

// Slack closes a native stream about ten minutes after chat.startStream.
const waitMinutes = (minutes: number) => ({
  kind: "checkpoint" as const,
  run: () => vi.advanceTimersByTimeAsync(minutes * 60_000),
});

it("rolls a slow think with sparse rows before Slack closes its stream", async () => {
  await dispatchCardsScenario({
    events: [
      reasoningSnapshot("Plan the migration."),
      settle,
      bashStart,
      waitMinutes(5),
      reasoningSnapshot("The suite is still running."),
      waitMinutes(4),
      // Past eight minutes: the next update rolls before it is sent.
      toolStart({ command: "pnpm build" }, { itemId: "tool-2" }),
      settle,
      { kind: "reasoning_end" },
      settle,
    ],
  });

  const [first = [], second = []] = expectStreamMessages(2);
  // The old message is sealed cleanly: its rows complete under the rolled title.
  const stop = first.at(-1);
  expect(stop?.kind).toBe("stop");
  const stopChunks = chunksOf(stop?.params ?? {});
  expect(stopChunks[0]).toEqual(planUpdate("Thinking, continued below"));
  for (const chunk of stopChunks.slice(1)) {
    expect(chunk).toMatchObject({ type: "task_update", status: "complete" });
  }
  expect(reasoningIdsOf(first)).toEqual([1, 2]);
  expect(carriesText(first)).toBe(false);
  // The new message continues with the next row and ends the turn.
  expect(second[0]?.kind).toBe("start");
  expect(taskRowsOf(second, /^tool_2$/u)).not.toHaveLength(0);
  expect(planTitlesOf(second).at(-1)).toMatch(/^Thought for \d+s, 2 tool calls$/u);
  expect(carriesText(second)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("streams the answer as its own message when the think outlives the stream age", async () => {
  await dispatchCardsScenario({
    events: [reasoningSnapshot("Plan the migration."), settle, waitMinutes(9)],
  });

  const [first = [], second = []] = expectStreamMessages(2);
  // The think closes with its summary on the old message; the answer starts fresh.
  expect(planTitlesOf(first).at(-1)).toMatch(/^Thought for \d+s$/u);
  expect(carriesText(first)).toBe(false);
  expect(carriesText(second, FINAL_REPLY_TEXT)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("rolls a slow tool-only turn on age and seals its tool rows complete", async () => {
  await dispatchCardsScenario({
    events: [
      bashStart,
      settle,
      { kind: "command_output", itemId: "tool-1", name: "bash", phase: "end", exitCode: 0 },
      waitMinutes(9),
      // Past eight minutes: the next update rolls before it is sent.
      toolStart({ command: "pnpm build" }, { itemId: "tool-2" }),
      settle,
    ],
  });

  const [first = [], second = []] = expectStreamMessages(2);
  const stop = first.at(-1);
  expect(stop?.kind).toBe("stop");
  const stopChunks = chunksOf(stop?.params ?? {});
  expect(stopChunks[0]).toEqual(planUpdate("Thinking, continued below"));
  for (const chunk of stopChunks.slice(1)) {
    expect(chunk).toMatchObject({ type: "task_update", status: "complete" });
  }
  expect(taskRowsOf(first, /^tool_1$/u).at(-1)).toMatchObject({ status: "complete" });
  expect(taskRowsOf(first, /^tool_2$/u)).toHaveLength(0);
  expect(reasoningIdsOf([...first, ...second])).toEqual([]);
  expect(second[0]?.kind).toBe("start");
  expect(taskRowsOf(second, /^tool_2$/u)).not.toHaveLength(0);
  expect(taskRowsOf(second, /^tool_1$/u)).toHaveLength(0);
  expect(carriesText(second)).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("keeps a short tool-only turn on one message", async () => {
  await dispatchCardsScenario({
    events: [bashStart, settle, toolStart({ command: "pnpm build" }, { itemId: "tool-2" }), settle],
  });

  const [only = []] = expectStreamMessages(1);
  expect(planTitlesOf(only)).not.toContainEqual(expect.stringMatching(/continued/u));
  expect(taskRowsOf(only, /^tool_[12]$/u)).not.toHaveLength(0);
  expect(carriesText(only)).toBe(true);
});

it.each([
  { when: "while the turn runs", events: [settle] },
  { when: "at closeout", events: [] },
])(
  "spreads a plan over as many messages as it needs without losing a step ($when)",
  async ({ events }) => {
    // Twenty 120-character CJK steps are about 15,800 size units (a CJK
    // character escapes to six): more than two messages' 7,000-unit row budget.
    const steps = Array.from({ length: 20 }, (_, index) => ({
      step: `${index + 1}`.padEnd(120, "漢"),
      status: "pending" as const,
    }));
    await dispatchCardsScenario({
      events: [{ kind: "plan", phase: "update", explanation: "Plan", steps }, ...events],
    });

    const messages = expectStreamMessages();
    expect(messages.length).toBeGreaterThanOrEqual(3);
    // Every step is on exactly one message; each message but the last continues below.
    const perMessage = messages.map((message) => [
      ...new Set(
        taskRowsOf(message, /^plan_step_\d+$/u).map((chunk) =>
          Number(/^plan_step_(\d+)/u.exec(String(chunk.id))?.[1]),
        ),
      ),
    ]);
    expect(perMessage.flat().toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    for (const message of messages.slice(0, -1)) {
      expect(planTitlesOf(message).at(-1)).toBe("Thinking, continued below");
    }
    expect(carriesText(messages.at(-1) ?? [])).toBe(true);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  },
);

it.each([
  { when: "while the turn runs", events: [settle] },
  { when: "at closeout", events: [] },
])(
  "delivers a same-status plan title revision made after a rollover once ($when)",
  async ({ events }) => {
    // Twenty 120-character CJK steps spread over three messages; step 1 is
    // on the first message only, then its title changes while still pending.
    const steps = Array.from({ length: 20 }, (_, index) => ({
      step: `${index + 1}`.padEnd(120, "漢"),
      status: "pending" as const,
    }));
    const revised = "Step one, revised";
    await dispatchCardsScenario({
      events: [
        { kind: "plan", phase: "update", explanation: "Plan", steps },
        settle,
        {
          kind: "plan",
          phase: "update",
          explanation: "Plan",
          steps: [{ step: revised, status: "pending" as const }, ...steps.slice(1)],
        },
        ...events,
      ],
    });

    const messages = expectStreamMessages();
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const stepOneTitles = messages.map((message) =>
      taskRowsOf(message, /^plan_step_1$/u).map((chunk) => String(chunk.title)),
    );
    expect(stepOneTitles[0]).toEqual([steps[0]?.step]);
    // The revision lands on exactly one later message, and that row ends revised.
    const carrying = stepOneTitles.flatMap((titles, index) =>
      titles.includes(revised) ? [index] : [],
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toBeGreaterThan(0);
    expect(stepOneTitles[carrying[0] ?? 0]?.at(-1)).toBe(revised);
    expect(stepOneTitles.flat().filter((title) => title === steps[0]?.step)).toHaveLength(1);
    expect(carriesText(messages.at(-1) ?? [])).toBe(true);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  },
);
