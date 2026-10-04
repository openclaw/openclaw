import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../auto-reply/heartbeat-tool-response.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../llm/types.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./embedded-agent-runner/run/terminal-outcome.js";
import { resolveSettledTurnFinalizationRequest } from "./embedded-agent-runner/run/terminal-resolution.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitToolRun,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeEmbeddedRunnerAttempt } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

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
  return makeAgentAssistantMessage({
    content: [
      {
        type: "text",
        text,
        ...(phase ? { textSignature: JSON.stringify({ v: 1, id: text, phase }) } : {}),
      },
    ],
    stopReason,
  });
}

function setup({
  deferred = false,
  block = true,
  ...options
}: Partial<Options> & { deferred?: boolean; block?: boolean } = {}) {
  const onBlockReply = vi.fn(options.onBlockReply);
  const onPartialReply = vi.fn(options.onPartialReply);
  const onAgentEvent = vi.fn(options.onAgentEvent);
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "terminal-delivery",
    blockReplyBreak: "message_end",
    ...(deferred ? { onBeforeTerminalDelivery: async () => undefined } : {}),
    ...options,
    onBlockReply: block ? onBlockReply : undefined,
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
  return {
    emit,
    subscription,
    message,
    tool,
    onBlockReply,
    onPartialReply,
    onAgentEvent,
    end: (messages: AssistantMessage[] = []) =>
      emit({ type: "agent_end", messages, willRetry: false }),
    drain: () => subscription.waitForPendingEvents(),
    assistantEvents: () =>
      onAgentEvent.mock.calls
        .filter(([event]) => event.stream === "assistant")
        .map(([event]) => event.data),
    lifecycleEnded: () =>
      onAgentEvent.mock.calls.some(
        ([event]) => event.stream === "lifecycle" && event.data.phase === "end",
      ),
  };
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

const internalEvents: Options["internalEvents"] = [
  {
    type: "task_completion",
    source: "music_generation",
    childSessionKey: "music_generate:track",
    announceType: "music generation task",
    taskLabel: "generated track",
    status: "ok",
    statusLabel: "completed successfully",
    result: "Generated a track.",
    mediaUrls: ["/tmp/generated.opus"],
    attachments: [{ path: "/tmp/generated.opus", mimeType: "audio/ogg", name: "generated.opus" }],
    replyInstruction: "Reply normally.",
  },
];
const generatedMedia = {
  mediaUrls: ["/tmp/generated.opus"],
  attachments: [
    {
      path: "/tmp/generated.opus",
      mimeType: "audio/ogg",
      name: "generated.opus",
      trustedLocalMedia: true,
    },
  ],
  audioAsVoice: undefined,
  trustedLocalMedia: true,
};
const voiceMedia = { mediaUrls: ["/tmp/reply.opus"], audioAsVoice: true };
const voiceResult = { details: { media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true } } };

describe("terminal delivery gate", () => {
  it.each(["suppress", "continue", "reject"] as const)(
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
      expect(h.onBlockReply).not.toHaveBeenCalled();
      expect(h.onPartialReply).not.toHaveBeenCalled();
      expect(h.assistantEvents()).toEqual([]);
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
      let drained = false;
      const draining = h.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      if (decision === "reject") {
        gate.reject(new Error("hook failed"));
      } else {
        gate.resolve(decision === "suppress" ? { suppressTerminalDelivery: true } : undefined);
      }
      await draining;
      expect(h.lifecycleEnded()).toBe(decision !== "suppress");
      if (decision === "suppress") {
        expect(h.onBlockReply).not.toHaveBeenCalled();
        expect(h.onPartialReply).not.toHaveBeenCalled();
        expect(h.assistantEvents()).toEqual([]);
      } else {
        expect(h.onBlockReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "Visible stream." }),
          { assistantMessageIndex: 1 },
        );
        expect(h.onPartialReply).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Visible stream.", delta: "Visible stream." }),
        );
        expect(h.assistantEvents()).toEqual([
          expect.objectContaining({ text: "Visible stream.", delta: "Visible stream." }),
        ]);
      }
    },
  );
});

describe("delivery failures", () => {
  it.each(["throw", "reject", "none"] as const)(
    "preserves tool-media ownership after %s",
    async (failure) => {
      const h = setup({
        builtinToolNames: new Set(["tts"]),
        onBlockReply: () => {
          if (failure === "throw") {
            throw new Error("sync delivery failed");
          }
          return failure === "reject"
            ? Promise.reject(new Error("async delivery failed"))
            : Promise.resolve();
        },
      });
      h.tool("tts", voiceResult);
      await h.drain();
      expect(h.subscription.getPendingToolMediaReply()).toEqual(voiceMedia);
      h.end();
      await h.drain();
      const delivered = failure === "none";
      expect(h.onBlockReply).toHaveBeenCalledOnce();
      expect(h.subscription.getPendingToolMediaReply()).toEqual(delivered ? null : voiceMedia);
      expect(h.subscription.getVisibleBlockReplyCount()).toBe(delivered ? 1 : 0);
      expect(h.subscription.hasToolMediaBlockReply()).toBe(delivered);
    },
  );

  it.each([
    { deferred: false, media: true, accepted: 0 },
    { deferred: true, media: true, accepted: 0 },
    { deferred: false, media: false, accepted: 1 },
  ])(
    "preserves delivery ownership after a rejection (%j)",
    async ({ deferred, media, accepted }) => {
      const callback = vi.fn().mockRejectedValue(new Error("reply rejected"));
      if (accepted) {
        callback.mockResolvedValueOnce(undefined);
      }
      const h = setup({
        deferred,
        internalEvents: media ? internalEvents : undefined,
        onBlockReply: callback,
      });
      if (media) {
        expect(h.subscription.getPendingToolMediaReply()).toEqual(generatedMedia);
      }
      h.message(answer(media ? "Here is your track." : "First delivered answer."), false);
      if (accepted) {
        await h.drain();
      }
      h.message(answer(media ? "Updated answer." : "Second rejected answer."), false);
      h.end();
      await h.drain();
      expect(callback).toHaveBeenCalledTimes(2);
      expect(h.subscription.getVisibleBlockReplyCount()).toBe(accepted);
      if (media) {
        expect(h.subscription.getPendingToolMediaReply()).toEqual(generatedMedia);
        expect(h.subscription.hasToolMediaBlockReply()).toBe(false);
      }
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
    const reasoning = makeAgentAssistantMessage({
      content: [{ type: "thinking", thinking: "Considering the reply" }],
    });
    h.message(reasoning, false);
    h.end([reasoning]);
    await h.drain();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith(voiceMedia);
    expect(h.subscription.getPendingToolMediaReply()).toBeNull();
    expect(h.subscription.getVisibleBlockReplyCount()).toBe(1);
    expect(h.subscription.hasToolMediaBlockReply()).toBe(true);
  });

  it.each(["progress", "presentation", "heartbeat"] as const)(
    "contains rejected %s callbacks",
    async (kind) => {
      const rejected = vi.fn().mockRejectedValue(new Error("callback failed"));
      const h = setup(
        kind === "progress"
          ? {
              onAgentEvent: rejected,
              onPartialReply: rejected,
              onAssistantMessageStart: rejected,
              onReasoningStream: rejected,
              onReasoningEnd: rejected,
              reasoningMode: "stream",
            }
          : {
              onToolResult: kind === "presentation" ? rejected : undefined,
              onHeartbeatToolResponse: kind === "heartbeat" ? rejected : undefined,
              verboseLevel: "full",
            },
      );
      if (kind === "progress") {
        h.message(answer("Hello"), false);
        emitAssistantTextDelta({ emit: h.emit, delta: "Hello" });
        for (const assistantMessageEvent of [
          { type: "thinking_delta", delta: "Because" },
          { type: "thinking_end" },
        ]) {
          h.emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent });
        }
      } else {
        h.tool(
          kind === "heartbeat" ? HEARTBEAT_RESPONSE_TOOL_NAME : "read",
          kind === "heartbeat"
            ? {
                details: {
                  status: "accepted",
                  outcome: "no_change",
                  notify: false,
                  summary: "Nothing needs attention.",
                },
              }
            : { content: [{ type: "text", text: "file contents" }] },
        );
      }
      await h.drain();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(rejected).toHaveBeenCalled();
    },
  );
});

describe("deferred reply supersession", () => {
  it.each(["immediate", "pending", "rejected"] as const)(
    "recovers a required reply without stealing %s delivery ownership",
    async (delivery) => {
      const markdown =
        "## Result\n\n- **Saved** the note.\n- Keep `note.md` unchanged.\n\n```text\nfirst  second\n```";
      const delivered: string[] = [],
        pending: string[] = [];
      const h = setup({
        onBlockReply: async ({ text }) => {
          if (delivery === "rejected") {
            throw new Error("delivery failed");
          }
          if (text) {
            (delivery === "pending" ? pending : delivered).push(text);
          }
        },
      });
      const user = { role: "user" as const, content: "Read the saved note.", timestamp: 0 };
      const toolCall = makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
        stopReason: "toolUse",
      });
      const result = {
        role: "toolResult" as const,
        toolCallId: "read",
        toolName: "read",
        content: [{ type: "text" as const, text: "Note saved." }],
        isError: false,
        timestamp: 1,
      };
      const final = answer(markdown, "toolUse", "final_answer"),
        silent = answer("NO_REPLY");
      h.emit({ type: "message_end", message: user });
      h.message(toolCall);
      h.tool("read", result);
      h.emit({ type: "message_end", message: result });
      for (const [message, toolResults] of [
        [toolCall, [result]],
        [final, []],
        [silent, []],
      ] as const) {
        if (message !== toolCall) {
          h.message(message);
        }
        h.emit({ type: "turn_end", message, toolResults });
      }
      const messages = [user, toolCall, result, final, silent];
      h.emit({ type: "agent_end", messages, willRetry: false });
      await h.drain();
      const assistant = h.subscription.getCurrentAttemptAssistant();
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: h.subscription.assistantTexts,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        lastAssistant: assistant,
        messagesSnapshot: messages,
        itemLifecycle: h.subscription.getItemLifecycle(),
        toolMetas: [{ toolName: "read", toolCallId: "read", isError: false, replaySafe: true }],
      });
      expect(h.subscription.assistantTexts).toEqual([markdown, "NO_REPLY"]);
      expect(attempt.itemLifecycle).toMatchObject({
        startedCount: 1,
        completedCount: 1,
        activeCount: 0,
      });
      expect(delivered).toEqual(delivery === "immediate" ? [markdown] : []);
      expect(pending).toEqual(delivery === "pending" ? [markdown] : []);
      expect(h.subscription.getVisibleBlockReplyCount()).toBe(delivery === "rejected" ? 0 : 1);
      const built = payloads(h.subscription);
      expect(built).toEqual([]);
      const request = resolveSettledTurnFinalizationRequest({
        runParams: {
          runId: "silent-tail",
          sessionId: "silent-tail",
          workspaceDir: "/synthetic",
          prompt: user.content,
          timeoutMs: 1000,
          terminalReplyExpectation: "required",
        },
        attempt,
        replyDeliveryState: delivered.length ? "delivered" : pending.length ? "pending" : "missing",
        activeErrorContext: { provider: "openai", model: "mock-1" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: built,
        hasTerminalToolPresentation: false,
        terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
        settledTurnFinalizationAvailable: true,
      });
      if (delivery === "rejected") {
        expect(request).toContain("Tools are unavailable");
      } else {
        expect(request).toBeNull();
      }
    },
  );

  it.each(["no tool", "read", "skipped"] as const)(
    "seals and delivers steered answers after %s",
    async (kind) => {
      const hasTool = kind !== "no tool";
      const skipped = kind === "skipped";
      const h = setup({ deferred: hasTool, block: hasTool });
      const first = answer(hasTool ? "A2" : "A");
      const final = answer(hasTool ? "A3" : "B");
      const user = (content: string) => ({ role: "user", content, timestamp: 0 });
      const userMessage = (content: string) => {
        const message = user(content);
        h.emit({ type: "message_start", message });
        h.emit({ type: "message_end", message });
      };
      const progress = makeAgentAssistantMessage({
        content: [
          { type: "text", text: "A1" },
          { type: "toolCall", id: "read", name: "read", arguments: {} },
        ],
        stopReason: "toolUse",
      });
      if (hasTool) {
        const result = {
          role: "toolResult",
          toolName: "read",
          toolCallId: "read",
          content: [
            {
              type: "text",
              text: skipped ? "Skipped due to queued user message." : "Read complete.",
            },
          ],
          isError: skipped,
          timestamp: 0,
        };
        h.message(progress);
        h.tool("read", result, skipped);
        if (!skipped) {
          h.emit({ type: "message_start", message: result });
          h.emit({ type: "message_end", message: result });
        }
        h.emit({ type: "turn_end", message: progress, toolResults: [result] });
      } else {
        userMessage("Initial question");
      }
      if (!skipped) {
        h.message(first);
        h.emit({ type: "turn_end", message: first, toolResults: [] });
      }
      if (!hasTool) {
        await h.drain();
        expect(payloads(h.subscription).map((payload) => payload.text)).toEqual(["A"]);
        expect(h.subscription.answerSegments).toHaveLength(0);
      }
      userMessage("Next question");
      if (!hasTool) {
        userMessage("Additional detail");
      }
      h.message(final);
      h.emit({ type: "turn_end", message: final, toolResults: [] });
      h.end(hasTool ? [progress, first, final] : [first, final]);
      await h.drain();
      const expected = hasTool ? [skipped ? "A1" : "A2", "A3"] : ["A", "B"];
      expect(payloads(h.subscription).map((payload) => payload.text)).toEqual(expected);
      if (hasTool) {
        expect(h.onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual(expected);
      } else {
        expect(h.subscription.answerSegments).toHaveLength(1);
      }
    },
  );

  it.each([
    { terminal: "Completed answer.", prior: "stop", prefix: false },
    { terminal: "NO_REPLY", prior: "toolUse", prefix: false },
    { terminal: "Result:complete", prior: "toolUse", prefix: true },
  ] as const)(
    "supersedes deferred $prior answers with $terminal",
    async ({ terminal, prior, prefix }) => {
      const h = setup({ deferred: true, blockReplyBreak: prefix ? "text_end" : "message_end" });
      const priorTexts = prefix
        ? ["Result:"]
        : ["Obsolete preflight answer.", "Obsolete follow-up answer."];
      const phase = prefix ? undefined : "final_answer";
      const messages = [...priorTexts, terminal].map((text, index) =>
        makeAgentAssistantMessage({
          ...answer(text, index < priorTexts.length ? prior : "stop", phase),
          content: [
            ...answer(text, "stop", phase).content,
            ...(index < priorTexts.length && !prefix
              ? [
                  {
                    type: "toolCall" as const,
                    id: `read-${index}`,
                    name: "read",
                    arguments: {},
                    async: true as const,
                  },
                ]
              : []),
          ],
        }),
      );
      for (const [index, message] of messages.entries()) {
        h.message(message);
        if (index < priorTexts.length) {
          h.tool("read", undefined, false, `read-${index}`);
          if (!prefix) {
            h.emit({
              type: "turn_end",
              message,
              toolResults: [
                {
                  role: "toolResult",
                  toolCallId: `read-${index}`,
                  toolName: "read",
                  content: [{ type: "text", text: "Successful result." }],
                  isError: false,
                  timestamp: 0,
                },
              ],
            });
          }
        }
        await h.drain();
      }
      expect(h.onBlockReply).not.toHaveBeenCalled();
      expect(h.onPartialReply).not.toHaveBeenCalled();
      expect(h.assistantEvents()).toEqual([]);
      h.end(messages);
      await h.drain();
      const expected = terminal === "NO_REPLY" ? [] : [terminal];
      expect(h.onBlockReply.mock.calls.map(([payload]) => payload.text).filter(Boolean)).toEqual(
        expected,
      );
      expect(h.onPartialReply.mock.calls.map(([payload]) => payload.text).filter(Boolean)).toEqual(
        expected,
      );
      expect(
        h
          .assistantEvents()
          .map((data) => data.text)
          .filter(Boolean),
      ).toEqual(expected);
      expect(h.lifecycleEnded()).toBe(true);
    },
  );

  it("preserves deferred media and reasoning while superseding obsolete captions", async () => {
    const h = setup({
      deferred: true,
      internalEvents,
      blockReplyBreak: "text_end",
      reasoningMode: "on",
    });
    const media = answer("Obsolete caption.\nMEDIA:/tmp/generated.opus", "toolUse", "final_answer");
    const commentary = makeAgentAssistantMessage({
      content: [
        { type: "thinking", thinking: "Checking the generated track." },
        ...answer("Checking current state.", "toolUse", "commentary").content,
      ],
      stopReason: "toolUse",
    });
    const final = makeAgentAssistantMessage({
      content: [
        ...answer("Completed answer.", "stop", "final_answer").content,
        ...answer("Second answer block.", "stop", "final_answer").content,
      ],
    });
    for (const message of [media, commentary, final]) {
      h.message(message);
      if (message === commentary) {
        h.tool();
      }
      await h.drain();
    }
    const events = h.onAgentEvent.mock.calls.map(([event]) => event);
    const preamble = events.findIndex(
      (event) => event.stream === "item" && event.data.kind === "preamble",
    );
    expect(
      events.findIndex((event) => event.stream === "item" && event.data.kind === "tool"),
    ).toBeGreaterThan(preamble);
    expect(h.onBlockReply).not.toHaveBeenCalled();
    expect(h.assistantEvents()).toEqual([]);
    expect(h.onAgentEvent).toHaveBeenCalledWith({
      stream: "item",
      data: expect.objectContaining({ kind: "preamble", progressText: "Checking current state." }),
    });
    h.end([media, commentary, final]);
    await h.drain();
    const replies = h.onBlockReply.mock.calls.map(([payload]) => payload);
    const mediaReplies = replies.filter((payload) => payload.mediaUrls?.length);
    expect(mediaReplies).toHaveLength(1);
    const mediaReply = mediaReplies[0];
    assert(mediaReply);
    expect(mediaReply).toMatchObject(generatedMedia);
    expect(mediaReply.text ?? "").toBe("");
    expect(getReplyPayloadMetadata(mediaReply)).toMatchObject({
      assistantTranscriptMediaUrls: ["/tmp/generated.opus"],
    });
    expect(replies.filter((payload) => payload.isReasoning).map((payload) => payload.text)).toEqual(
      ["Checking the generated track."],
    );
    expect(
      replies
        .filter((payload) => !payload.isReasoning)
        .map((payload) => payload.text)
        .filter(Boolean),
    ).toEqual(["Completed answer.", "Second answer block."]);
    expect(h.assistantEvents()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("Obsolete") }),
      ]),
    );
    expect(
      h
        .assistantEvents()
        .filter((data) => Array.isArray(data.mediaUrls) && data.mediaUrls.length > 0),
    ).toEqual([expect.objectContaining({ text: "", mediaUrls: ["/tmp/generated.opus"] })]);
    expect(h.subscription.hasToolMediaBlockReply()).toBe(true);
    expect(h.subscription.getPendingToolMediaReply()).toBeNull();
  });
});

it.each([false, true])("keeps checkpoint delivery nonterminal (buffered=%s)", async (buffered) => {
  const decide = vi
    .fn()
    .mockResolvedValueOnce({ continueCurrentTurn: true })
    .mockResolvedValueOnce(undefined);
  const h = setup({ onBeforeTerminalDelivery: decide, deferTerminalDelivery: buffered });
  h.message(answer("Checkpoint: a repair remains."));
  await h.drain();
  expect(h.assistantEvents().some((data) => data.text === "Checkpoint: a repair remains.")).toBe(
    !buffered,
  );
  h.end();
  await h.drain();
  expect(h.lifecycleEnded()).toBe(false);
  expect(h.assistantEvents().some((data) => data.text === "Checkpoint: a repair remains.")).toBe(
    true,
  );
  h.emit({ type: "agent_start" });
  h.message(answer("All repairs verified."));
  await h.drain();
  expect(h.assistantEvents().some((data) => data.text === "All repairs verified.")).toBe(!buffered);
  h.end();
  await h.drain();
  expect(h.lifecycleEnded()).toBe(true);
  expect(payloads(h.subscription).map((payload) => payload.text)).toEqual([
    "All repairs verified.",
  ]);
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
  h.end();
  await h.drain();
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ hasPendingContinuation: true }));
});
