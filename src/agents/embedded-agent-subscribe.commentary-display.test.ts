import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { projectInFlightRunSnapshot } from "../gateway/chat-inflight-snapshot.js";
import { createAgentEventTestHarness } from "../gateway/server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "../gateway/server-chat.agent-events.test-helpers.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { createOpenAiResponsesTextBlock } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">;
type TestAssistant = Pick<AssistantMessage, "role" | "content"> &
  Partial<Pick<AssistantMessage, "api" | "stopReason" | "openclawDelivery">> & {
    phase?: "commentary" | "final_answer";
  };
function commentaryHarness(options: Options) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-05-09T00:00:00.000Z"));
  const gateway = createAgentEventTestHarness();
  gateway.register("run", "main", "run");
  const unsubscribe = subscribeAgentEvents((event) => {
    if (event.runId === "run") {
      return gateway.handler(event);
    }
  });
  const finishing = createDeferred();
  const finish = createDeferred();
  const onAgentEvent = vi.fn();
  const source = createSubscribedSessionHarness({
    runId: "run",
    onAgentEvent,
    ...options,
    onBeforeLifecycleTerminal: () => {
      finishing.resolve();
      return finish.promise;
    },
  });
  onTestFinished(async () => {
    finish.resolve();
    await source.subscription.waitForPendingEvents();
    source.subscription.unsubscribe();
    await unsubscribe();
    await gateway.handler.dispose();
    gateway.chatRunState.clear();
    vi.useRealTimers();
  });
  const settle = async () => {
    await source.subscription.waitForPendingEvents();
    await unsubscribe.drain();
  };
  return {
    ...source,
    events: () => onAgentEvent.mock.calls.map(([event]) => event),
    broadcast: gateway.broadcast,
    finishing: finishing.promise,
    drain: unsubscribe.drain,
    settle,
    snapshot: async () => {
      await settle();
      gateway.chatRunState.flushPendingText("run");
      return projectInFlightRunSnapshot({ chatRunState: gateway.chatRunState, runId: "run" }).text;
    },
  };
}
function update(
  emit: ReturnType<typeof createSubscribedSessionHarness>["emit"],
  message: TestAssistant,
  type: "text_delta" | "text_end" | "toolcall_start",
  text?: string,
  contentIndex?: number,
) {
  emit({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type,
      ...(text === undefined ? {} : type === "text_delta" ? { delta: text } : { content: text }),
      ...(contentIndex === undefined ? {} : { contentIndex, partial: message }),
    },
  });
}
function textMessage(text: string, api: TestAssistant["api"]): TestAssistant {
  return { ...textAssistant(text), api };
}
function textBlock(text: string, id: string, phase: "commentary" | "final_answer") {
  return { ...createOpenAiResponsesTextBlock({ text, id, phase }), type: "text" as const };
}
function responseMessage(...content: TestAssistant["content"]): TestAssistant {
  return { role: "assistant", api: "openai-responses", content };
}
const containingEvent = (data: Record<string, unknown>, stream = "assistant") =>
  expect.objectContaining({ stream, data: expect.objectContaining(data) });
it.each(["anthropic-messages", "openai-responses"] as const)(
  "coalesces %s commentary and preserves its complete boundary text",
  async (api) => {
    const { emit, subscription, events } = commentaryHarness({});
    const message = (text: string): TestAssistant => ({
      role: "assistant",
      api,
      phase: "commentary",
      content: [textBlock(text, "commentary-paced", "commentary")],
    });
    const progress = () =>
      events()
        .filter((event) => event.stream === "item")
        .map((event) => event.data.progressText);
    emit({ type: "message_start", message: message("") });
    let text = "";
    for (const delta of ["Checking", " the", " café 🦞."]) {
      text += delta;
      update(emit, message(text), "text_delta", delta, 0);
    }
    await subscription.waitForPendingEvents();
    expect(progress()).toEqual(["Checking"]);
    update(emit, message(text), "text_end", text, 0);
    await subscription.waitForPendingEvents();
    expect(progress().at(-1)).toBe("Checking the café 🦞.");
  },
);

it.each(["anthropic-messages", "openai-completions"] as const)(
  "preserves unphased %s narration inline across a tool call",
  async (api) => {
    const { emit, snapshot, events } = commentaryHarness({});
    const narration = "Checking the workspace.\n\n```sh\n  pwd\n```";
    emit({ type: "message_start", message: textMessage("", api) });
    update(emit, textMessage(narration, api), "text_delta", narration);
    expect(await snapshot()).toContain("Checking the workspace.");

    const toolMessage = textMessage(narration, api);
    toolMessage.stopReason = "toolUse";
    toolMessage.content.push({ type: "toolCall", id: "exec_0", name: "exec", arguments: {} });
    update(emit, toolMessage, "toolcall_start", undefined, 1);
    emit({ type: "message_end", message: toolMessage });
    expect(await snapshot()).toBe(narration);
    expect(events().some((event) => event.stream === "item")).toBe(false);

    const next = textMessage("Next answer.", api);
    emit({ type: "message_start", message: textMessage("", api) });
    update(emit, next, "text_delta", "Next answer.");
    emit({ type: "message_end", message: { ...next, stopReason: "stop" } });
    expect(await snapshot()).toBe(`${narration}\n\nNext answer.`);
  },
);

it.each([
  ["text_delta", false],
  ["text_end", false],
  ["text_end", true],
] as const)(
  "preserves final answers when commentary appears at %s (deferred=%s)",
  async (phaseKnownAt, deferred) => {
    const answerText = "Accepted answer.";
    const commentaryText = "Checking a detail.";
    const continuationText = "Continuing answer.";
    const interimText = `${answerText}\n${commentaryText}`;
    const correctedLive = phaseKnownAt === "text_end" && !deferred;
    const { emit, snapshot, settle, finishing, broadcast, drain, events } = commentaryHarness(
      deferred ? { onBeforeTerminalDelivery: () => undefined } : {},
    );
    const answerBlock = textBlock(answerText, "answer-0", "final_answer");
    const commentaryBlock = textBlock(commentaryText, "commentary-0", "commentary");
    const answer = responseMessage(answerBlock);
    emit({ type: "message_start", message: answer });
    update(emit, answer, "text_delta", answerText, 0);
    const mixed = responseMessage(answerBlock, commentaryBlock);
    const partial =
      phaseKnownAt === "text_delta"
        ? mixed
        : responseMessage(answerBlock, { type: "text", text: commentaryText });
    update(emit, partial, "text_delta", commentaryText, 1);
    if (correctedLive) {
      expect(events().at(-1)).toMatchObject({
        stream: "assistant",
        data: { text: expect.stringContaining("Checking a detail.") },
      });
      expect(await snapshot()).toBe(interimText);
      expect(broadcast.mock.calls.findLast(([event]) => event === "chat")?.[1]).toMatchObject({
        message: { content: [{ type: "text", text: interimText }] },
      });
      broadcast.mockClear();
    }
    update(emit, mixed, "text_end", commentaryText, 1);
    await settle();
    if (correctedLive) {
      const correction = broadcast.mock.calls.findIndex(([event]) => event === "chat");
      const preamble = broadcast.mock.calls.findIndex(
        ([event, payload]) => event === "agent" && payload.data?.kind === "preamble",
      );
      expect(correction).toBeGreaterThanOrEqual(0);
      expect(broadcast.mock.calls[correction]?.[1]).toMatchObject({
        replace: true,
        deltaText: "Accepted answer.",
      });
      expect(preamble).toBeGreaterThan(correction);
    }
    const current = events().findLast((event) => event.stream === "assistant");
    if (deferred) {
      expect(current).toBeUndefined();
    } else {
      expect(current?.data.text).toBe(phaseKnownAt === "text_delta" ? answerText : interimText);
    }
    expect(await snapshot()).toBe(answerText);
    const continued = correctedLive
      ? responseMessage(...mixed.content, textBlock(continuationText, "answer-1", "final_answer"))
      : mixed;
    if (continued !== mixed) {
      update(emit, continued, "text_delta", continuationText, 2);
      expect(await snapshot()).toBe("Accepted answer.\nContinuing answer.");
    }
    emit({ type: "message_end", message: continued });
    await settle();
    if (deferred) {
      emit({ type: "agent_end", messages: [continued] });
      await finishing;
      await drain();
    }

    const assistant = events().filter((event) => event.stream === "assistant");
    const expectedAnswer = correctedLive ? `${answerText}\n${continuationText}` : answerText;
    expect(assistant.length).toBeGreaterThan(0);
    if (phaseKnownAt === "text_delta") {
      expect(assistant.every((event) => event.data.text === "Accepted answer.")).toBe(true);
    } else {
      expect(assistant).toContainEqual(containingEvent({ text: interimText }));
      expect(assistant).toContainEqual(containingEvent({ text: expectedAnswer, replace: true }));
    }
    expect(events()).toContainEqual(
      containingEvent({ itemId: "commentary-0", progressText: commentaryText }, "item"),
    );
    expect(await snapshot()).toBe(expectedAnswer);
  },
);
