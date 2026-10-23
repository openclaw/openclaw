import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../llm/types.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitToolRun,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { taskCompletionEvents } from "./subagent-test-fixtures.test-helpers.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { textAssistant, textToolResult } from "./test-helpers/sparse-transcript.test-support.js";

const visibleTexts = (replies: { text?: unknown }[]) =>
  replies.map(({ text }) => text).filter(Boolean);
type Options = Parameters<typeof createSubscribedSessionHarness>[0];
const subscriptions: ReturnType<typeof createSubscribedSessionHarness>["subscription"][] = [];
const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};
beforeEach(() => {
  process.on("unhandledRejection", onUnhandledRejection);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandledRejection);
  for (const subscription of subscriptions.splice(0)) {
    subscription.unsubscribe();
  }
  expect(unhandledRejections.splice(0)).toEqual([]);
});

function answer(text: string, stopReason: AssistantMessage["stopReason"] = "stop", phase?: string) {
  const signature = phase ? { textSignature: JSON.stringify({ v: 1, id: text, phase }) } : {};
  return assistantMessage([{ type: "text", text, ...signature }], stopReason);
}

const readCall = () => ({ type: "toolCall", id: "read", name: "read", arguments: {} }) as const;
const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const readResult = (text: string, isError = false, timestamp = 0) => ({
  ...textToolResult("read", "read", text, { isError }),
  isError,
  timestamp,
});
const assistantMessage = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
) => makeAgentAssistantMessage({ content, stopReason });

function setup({ deferred = false, ...options }: Partial<Options> & { deferred?: boolean } = {}) {
  const onBlockReply = vi.fn(options.onBlockReply);
  const onPartialReply = vi.fn(options.onPartialReply);
  const onAgentEvent = vi.fn(options.onAgentEvent);
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "terminal-delivery",
    blockReplyBreak: "message_end",
    ...(deferred ? { onBeforeTerminalDelivery: async () => undefined } : {}),
    ...options,
    onBlockReply,
    onPartialReply,
    onAgentEvent,
  });
  subscriptions.push(subscription);
  const message = (value: AssistantMessage, stream = true) => {
    emit({ type: "message_start", message: value });
    if (stream) {
      for (const [contentIndex, content] of value.content.entries()) {
        if (content.type !== "text") {
          continue;
        }
        const partial = { ...value, content: value.content.slice(0, contentIndex + 1) };
        for (const update of [
          { type: "text_delta", delta: content.text },
          { type: "text_end", content: content.text },
        ]) {
          emit({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { ...update, contentIndex, partial },
          });
        }
      }
    }
    emit({ type: "message_end", message: value });
  };
  const tool = (
    toolName = "read",
    result: unknown = { content: [{ type: "text", text: "Read complete." }] },
    isError = false,
    toolCallId = toolName,
  ) => {
    emitToolRun({ emit, toolName, toolCallId, args: {}, result, isError });
  };
  const assistantEvents = () =>
    onAgentEvent.mock.calls
      .filter(([event]) => event.stream === "assistant")
      .map(([event]) => event.data);
  return {
    emit,
    subscription,
    message,
    tool,
    onBlockReply,
    onPartialReply,
    onAgentEvent,
    replies: () => onBlockReply.mock.calls.map(([payload]) => payload),
    partials: () => onPartialReply.mock.calls.map(([payload]) => payload),
    turn: (value: AssistantMessage, toolResults: readonly unknown[] = []) =>
      emit({ type: "turn_end", message: value, toolResults }),
    rawMessage: (value: unknown) => {
      emit({ type: "message_start", message: value });
      emit({ type: "message_end", message: value });
    },
    end: (messages: AssistantMessage[] = []) =>
      emit({ type: "agent_end", messages, willRetry: false }),
    finish: async (messages: AssistantMessage[] = []) => {
      emit({ type: "agent_end", messages, willRetry: false });
      await subscription.waitForPendingEvents();
    },
    drain: () => subscription.waitForPendingEvents(),
    assistantEvents,
    hasAssistantText: (text: string) => assistantEvents().some((data) => data.text === text),
    lifecycleEnded: () =>
      onAgentEvent.mock.calls.some(
        ([event]) => event.stream === "lifecycle" && event.data.phase === "end",
      ),
  };
}

function expectMediaState(h: ReturnType<typeof setup>, pending: unknown, visible: number) {
  expect({
    pending: h.subscription.getPendingToolMediaReply(),
    visible: h.subscription.getVisibleBlockReplyCount(),
    delivered: h.subscription.hasToolMediaBlockReply(),
  }).toEqual({ pending, visible, delivered: visible > 0 });
}

function expectNoReplies(h: ReturnType<typeof setup>) {
  expect(h.onBlockReply).not.toHaveBeenCalled();
  expect(h.onPartialReply).not.toHaveBeenCalled();
  expect(h.assistantEvents()).toEqual([]);
}

function payloads(subscription: ReturnType<typeof setup>["subscription"]) {
  const currentAssistant = subscription.getCurrentAttemptAssistant();
  return buildEmbeddedRunPayloads({
    assistantTexts: subscription.assistantTexts,
    answerSegments: subscription.answerSegments,
    assistantMessageIndex: subscription.getLastAssistantTextMessageIndex(),
    lastAssistant: currentAssistant,
    currentAssistant: currentAssistant ?? null,
    sessionKey: "steered-answers",
  });
}

const attachment = { path: "/tmp/generated.opus", mimeType: "audio/ogg", name: "generated.opus" };
const internalEvents = taskCompletionEvents({
  source: "music_generation",
  mediaUrls: [attachment.path],
  attachments: [attachment],
});
const generatedMedia = {
  mediaUrls: ["/tmp/generated.opus"],
  attachments: [{ ...attachment, trustedLocalMedia: true }],
  audioAsVoice: undefined,
  trustedLocalMedia: true,
};
const voiceMedia = { mediaUrls: ["/tmp/reply.opus"], audioAsVoice: true };
const voiceResult = { details: { media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true } } };

it.each(["suppress", "reject"] as const)(
  "joins the pending gate and handles %s",
  async (decision) => {
    const gate = createDeferred<void | { suppressTerminalDelivery: true }>();
    const entered = createDeferred();
    const onBeforeTerminalDelivery = vi.fn(() => {
      entered.resolve();
      return gate.promise;
    });
    const h = setup({ onBeforeTerminalDelivery });
    const message = answer("Visible stream.");
    h.message(message);
    expectNoReplies(h);
    h.end([message]);
    await entered.promise;
    expect(onBeforeTerminalDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        hasAssistantVisibleText: true,
        isError: false,
        incompleteTerminalAssistant: false,
        willRetry: false,
      }),
    );
    const drained = vi.fn();
    const draining = h.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    if (decision === "reject") {
      gate.reject(new Error("hook failed"));
    } else {
      gate.resolve({ suppressTerminalDelivery: true });
    }
    await draining;
    expect(h.lifecycleEnded()).toBe(decision !== "suppress");
    if (decision === "suppress") {
      expectNoReplies(h);
    } else {
      const delta = expect.objectContaining({ text: "Visible stream.", delta: "Visible stream." });
      expect(h.onBlockReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Visible stream." }),
        { assistantMessageIndex: 1 },
      );
      expect(h.onPartialReply).toHaveBeenCalledWith(delta);
      expect(h.assistantEvents()).toEqual([delta]);
    }
  },
);
it.each(["synchronous", "deferred"] as const)(
  "preserves media ownership after %s delivery failures",
  async (kind) => {
    const deferred = kind === "deferred";
    const h = setup({
      deferred,
      ...(deferred ? { internalEvents } : { builtinToolNames: new Set(["tts"]) }),
      onBlockReply: () => {
        const error = new Error("delivery failed");
        if (deferred) {
          return Promise.reject(error);
        }
        throw error;
      },
    });
    if (!deferred) {
      h.tool("tts", voiceResult);
      await h.drain();
    }
    const media = deferred ? generatedMedia : voiceMedia;
    expect(h.subscription.getPendingToolMediaReply()).toEqual(media);
    if (deferred) {
      h.message(answer("Here is your track."), false);
      h.message(answer("Updated answer."), false);
    }
    await h.finish();
    expect(h.onBlockReply).toHaveBeenCalledTimes(deferred ? 2 : 1);
    expectMediaState(h, media, 0);
  },
);

it("delivers queued media after a rejected reasoning reply", async () => {
  const callback = vi
    .fn()
    .mockRejectedValueOnce(new Error("reasoning failed"))
    .mockResolvedValueOnce(undefined);
  const h = setup({
    onBlockReply: callback,
    reasoningMode: "on",
    thinkingLevel: "medium",
    builtinToolNames: new Set(["tts"]),
  });
  h.tool("tts", voiceResult);
  await h.drain();
  const reasoning = assistantMessage([{ type: "thinking", thinking: "Considering the reply" }]);
  h.message(reasoning, false);
  await h.finish([reasoning]);
  expect(callback).toHaveBeenCalledTimes(2);
  expect(callback).toHaveBeenLastCalledWith(voiceMedia);
  expectMediaState(h, null, 1);
});

it("contains rejected progress callbacks", async () => {
  const rejected = vi.fn().mockRejectedValue(new Error("callback failed"));
  const h = setup({
    onAgentEvent: rejected,
    onPartialReply: rejected,
    onAssistantMessageStart: rejected,
    onReasoningStream: rejected,
    onReasoningEnd: rejected,
    reasoningMode: "stream",
  });
  h.message(answer("Hello"), false);
  emitAssistantTextDelta({ emit: h.emit, delta: "Hello" });
  for (const assistantMessageEvent of [
    { type: "thinking_delta", delta: "Because" },
    { type: "thinking_end" },
  ]) {
    h.emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent });
  }
  await h.drain();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(rejected).toHaveBeenCalled();
});
it.each(["immediate", "rejected"] as const)(
  "honors terminal silence without stealing %s delivery ownership",
  async (delivery) => {
    const markdown =
      "## Result\n\n- **Saved** the note.\n- Keep `note.md` unchanged.\n\n```text\nfirst  second\n```";
    const delivered: string[] = [];
    const h = setup({
      onBlockReply: async ({ text }) => {
        if (delivery === "rejected") {
          throw new Error("delivery failed");
        }
        if (text) {
          delivered.push(text);
        }
      },
    });
    const prompt = user("Read the saved note.");
    const toolCall = assistantMessage([readCall()], "toolUse");
    const result = readResult("Note saved.", false, 1);
    const final = answer(markdown, "toolUse", "final_answer"),
      silent = answer("NO_REPLY");
    h.emit({ type: "message_end", message: prompt });
    h.message(toolCall);
    h.tool("read", result);
    h.emit({ type: "message_end", message: result });
    h.turn(toolCall, [result]);
    for (const message of [final, silent]) {
      h.message(message);
      h.turn(message);
    }
    const messages = [prompt, toolCall, result, final, silent];
    h.emit({ type: "agent_end", messages, willRetry: false });
    await h.drain();
    expect(h.subscription.assistantTexts).toEqual([markdown]);
    expect(h.subscription.getItemLifecycle()).toMatchObject({
      startedCount: 1,
      completedCount: 1,
      activeCount: 0,
    });
    expect(delivered).toEqual(delivery === "immediate" ? [markdown] : []);
    expect(h.subscription.getVisibleBlockReplyCount()).toBe(delivery === "rejected" ? 0 : 1);
    expect(payloads(h.subscription)).toEqual([]);
  },
);

it.each(["read", "skipped"] as const)(
  "seals and delivers steered answers after %s",
  async (kind) => {
    const skipped = kind === "skipped";
    const h = setup({ deferred: true });
    const first = answer("A2");
    const final = answer("A3");
    const progress = assistantMessage([{ type: "text", text: "A1" }, readCall()], "toolUse");
    const result = readResult(
      skipped ? "Skipped due to queued user message." : "Read complete.",
      skipped,
    );
    h.message(progress);
    h.tool("read", result, skipped);
    if (!skipped) {
      h.rawMessage(result);
    }
    h.turn(progress, [result]);
    if (!skipped) {
      h.message(first);
      h.turn(first);
    }
    h.rawMessage(user("Next question"));
    h.rawMessage(user("Additional detail"));
    h.message(final);
    h.turn(final);
    await h.finish([progress, first, final]);
    const expected = [skipped ? "A1" : "A2", "A3"];
    expect(payloads(h.subscription).map((payload) => payload.text)).toEqual(expected);
    expect(h.replies().map((payload) => payload.text)).toEqual(expected);
    expect(h.subscription.answerSegments).toHaveLength(1);
  },
);

it("preserves the undelivered prefix when a deferred answer extends it", async () => {
  const h = setup({ deferred: true, blockReplyBreak: "text_end" });
  const first = answer("Result:", "toolUse");
  const final = answer("Result:complete");
  const messages = [first, final];
  h.message(first);
  h.tool("read", undefined, false, "read-0");
  await h.drain();
  h.message(final);
  await h.drain();
  expectNoReplies(h);
  await h.finish(messages);
  expect(visibleTexts(h.replies())).toEqual(["Result:complete"]);
  expect(visibleTexts(h.partials())).toEqual(["Result:complete"]);
  expect(
    h
      .assistantEvents()
      .map((event) => event.text)
      .filter(Boolean),
  ).toEqual(["Result:complete"]);
  expect(h.lifecycleEnded()).toBe(true);
});

it("preserves deferred media and reasoning while superseding obsolete captions", async () => {
  const h = setup({
    deferred: true,
    internalEvents,
    blockReplyBreak: "text_end",
    reasoningMode: "on",
  });
  const media = answer("Obsolete caption.\nMEDIA:/tmp/generated.opus", "toolUse", "final_answer");
  const progress = "Checking current state.";
  const thinking = "Checking the generated track.";
  const commentary = assistantMessage(
    [{ type: "thinking", thinking }, ...answer(progress, "toolUse", "commentary").content],
    "toolUse",
  );
  const final = assistantMessage([
    ...answer("Completed answer.", "stop", "final_answer").content,
    ...answer("Second answer block.", "stop", "final_answer").content,
  ]);
  for (const message of [media, commentary, final]) {
    h.message(message);
    if (message === commentary) {
      h.tool();
    }
    await h.drain();
  }
  const events = h.onAgentEvent.mock.calls.map(([event]) => event);
  const itemIndex = (kind: string) =>
    events.findIndex((event) => event.stream === "item" && event.data.kind === kind);
  expect(itemIndex("tool")).toBeGreaterThan(itemIndex("preamble"));
  expect(h.onBlockReply).not.toHaveBeenCalled();
  expect(h.assistantEvents()).toEqual([]);
  expect(h.onAgentEvent).toHaveBeenCalledWith({
    stream: "item",
    data: expect.objectContaining({ kind: "preamble", progressText: progress }),
  });
  await h.finish([media, commentary, final]);
  const replies = h.replies();
  const mediaReplies = replies.filter((payload) => payload.mediaUrls?.length);
  expect(mediaReplies).toHaveLength(1);
  const mediaReply = mediaReplies[0];
  assert(mediaReply);
  expect(mediaReply).toMatchObject(generatedMedia);
  expect(mediaReply.text ?? "").toBe("");
  expect(getReplyPayloadMetadata(mediaReply)).toMatchObject({
    assistantTranscriptMediaUrls: ["/tmp/generated.opus"],
  });
  expect(replies.filter((payload) => payload.isReasoning).map(({ text }) => text)).toEqual([
    thinking,
  ]);
  expect(visibleTexts(replies.filter((payload) => !payload.isReasoning))).toEqual([
    "Completed answer.",
    "Second answer block.",
  ]);
  const assistantEvents = h.assistantEvents();
  const obsolete = expect.objectContaining({ text: expect.stringContaining("Obsolete") });
  expect(assistantEvents).not.toEqual(expect.arrayContaining([obsolete]));
  const mediaEvents = assistantEvents.filter(
    (data) => Array.isArray(data.mediaUrls) && data.mediaUrls.length > 0,
  );
  expect(mediaEvents).toEqual([
    expect.objectContaining({ text: "", mediaUrls: [attachment.path] }),
  ]);
  expect(h.subscription.hasToolMediaBlockReply()).toBe(true);
  expect(h.subscription.getPendingToolMediaReply()).toBeNull();
});

it("keeps buffered checkpoint delivery nonterminal", async () => {
  const decide = vi
    .fn()
    .mockResolvedValueOnce({ continueCurrentTurn: true })
    .mockResolvedValueOnce(undefined);
  const h = setup({ onBeforeTerminalDelivery: decide, deferTerminalDelivery: true });
  const checkpoint = "Checkpoint: a repair remains.",
    final = "All repairs verified.";
  for (const text of [checkpoint, final]) {
    h.message(answer(text));
    await h.drain();
    expect(h.hasAssistantText(text)).toBe(false);
    await h.finish();
    expect(h.lifecycleEnded()).toBe(text === final);
    if (text === checkpoint) {
      expect(h.hasAssistantText(text)).toBe(true);
      h.emit({ type: "agent_start" });
    }
  }
  expect(payloads(h.subscription).map((payload) => payload.text)).toEqual([final]);
});

it("exposes accepted child completion custody to the natural-stop decision", async () => {
  const decide = vi.fn(async () => undefined);
  const h = setup({ onBeforeTerminalDelivery: decide, deferTerminalDelivery: false });
  h.tool("sessions_spawn", {
    content: [{ type: "text", text: "Accepted" }],
    details: {
      status: "accepted",
      runId: "child-run",
      childSessionKey: "agent:main:subagent:child",
      expectsCompletionMessage: true,
    },
  });
  h.message(answer("The child is working."));
  await h.finish();
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ hasPendingContinuation: true }));
});

it.each(["text_end", "message_end"] as const)(
  "waits for async block replies before the %s flush",
  async (blockReplyBreak) => {
    const delivered: string[] = [];
    const snapshots: string[][] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: `async-flush-${blockReplyBreak}`,
      blockReplyBreak,
      blockReplyChunking: { minChars: 50, maxChars: 200 },
      onBlockReply: async ({ text }) => {
        await Promise.resolve();
        if (text) {
          delivered.push(text);
        }
      },
      onBlockReplyFlush: () => {
        snapshots.push([...delivered]);
      },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Short chunk." });
    emit(
      blockReplyBreak === "text_end"
        ? { type: "tool_execution_start", toolName: "bash", toolCallId: "flush", args: {} }
        : { type: "message_end", message: textAssistant("Short chunk.") },
    );
    await subscription.waitForPendingEvents();
    expect(delivered).toEqual(["Short chunk."]);
    expect(snapshots).toEqual([["Short chunk."]]);
    subscription.unsubscribe();
  },
);
