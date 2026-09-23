// Deferred reply regressions exercise the real subscription and delivery callbacks.
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../llm/types.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./embedded-agent-runner/run/terminal-outcome.js";
import { resolveSettledTurnFinalizationRequest } from "./embedded-agent-runner/run/terminal-resolution.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeEmbeddedRunnerAttempt } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

function hasAssistantEvent(calls: Array<unknown[]>): boolean {
  // The gate buffers assistant stream events; tests use this helper to assert
  // nothing leaks before the terminal decision resolves.
  return calls.some((call) => {
    const event = call[0] as { stream?: string } | undefined;
    return event?.stream === "assistant";
  });
}

function hasLifecycleEndEvent(calls: Array<unknown[]>): boolean {
  return calls.some((call) => {
    const event = call[0] as { stream?: string; data?: { phase?: string } } | undefined;
    return event?.stream === "lifecycle" && event.data?.phase === "end";
  });
}

function emitAssistantMessage(
  emit: (event: unknown) => void,
  message: AssistantMessage,
  stream = true,
) {
  emit({ type: "message_start", message });
  if (stream) {
    for (const [contentIndex, block] of message.content.entries()) {
      if (block.type !== "text") {
        continue;
      }
      const partial = { ...message, content: message.content.slice(0, contentIndex + 1) };
      for (const update of [
        { type: "text_delta", delta: block.text },
        { type: "text_end", content: block.text },
      ]) {
        emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: { ...update, contentIndex, partial },
        });
      }
    }
  }
  emit({ type: "message_end", message });
}

function buildSubscriptionPayloads(
  subscription: ReturnType<typeof createSubscribedSessionHarness>["subscription"],
) {
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

describe("subscribeEmbeddedAgentSession deferred reply supersession", () => {
  it.each(["immediate", "pending", "rejected", "deferred", "none"] as const)(
    "recovers a missing required reply without stealing %s delivery ownership",
    async (delivery) => {
      const markdown =
        "## Result\n\n- **Saved** the note.\n- Keep `note.md` unchanged.\n\n```text\nfirst  second\n```";
      const delivered: string[] = [];
      const pending: string[] = [];
      const onBlockReply = vi.fn(async (payload: { text?: string }) => {
        if (delivery === "rejected") {
          throw new Error("synthetic delivery failure");
        }
        if (delivery === "pending" && payload.text) {
          pending.push(payload.text);
          return;
        }
        if (payload.text) {
          delivered.push(payload.text);
        }
      });
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `silent-tail-${delivery}`,
        onBlockReply: delivery === "none" ? undefined : onBlockReply,
        onBeforeTerminalDelivery: delivery === "deferred" ? async () => undefined : undefined,
        blockReplyBreak: "message_end",
      });
      const user = { role: "user" as const, content: "Read the saved note.", timestamp: 0 };
      const toolCall = makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "read-note", name: "read", arguments: {} }],
        stopReason: "toolUse",
      });
      const result = { content: [{ type: "text" as const, text: "Note saved." }] };
      const toolResult = {
        role: "toolResult" as const,
        toolCallId: "read-note",
        toolName: "read",
        ...result,
        isError: false,
        timestamp: 1,
      };
      const answer = makeAgentAssistantMessage({
        content: [
          {
            type: "text",
            text: markdown,
            textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
          },
        ],
        stopReason: "toolUse",
      });
      const silent = makeAgentAssistantMessage({ content: [{ type: "text", text: "NO_REPLY" }] });
      const messages = [user, toolCall, toolResult, answer, silent];
      try {
        // Settlement precedes the formatted answer. The later canonical NO_REPLY
        // removes unsent text, but only the transport can prove delivery or custody.
        emit({ type: "message_end", message: user });
        emitAssistantMessage(emit, toolCall);
        emit({ type: "tool_execution_start", toolName: "read", toolCallId: "read-note", args: {} });
        emit({
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "read-note",
          result,
          isError: false,
        });
        emit({ type: "message_end", message: toolResult });
        emit({ type: "turn_end", message: toolCall, toolResults: [toolResult] });
        emitAssistantMessage(emit, answer);
        emit({ type: "turn_end", message: answer, toolResults: [] });
        emitAssistantMessage(emit, silent);
        emit({ type: "turn_end", message: silent, toolResults: [] });
        emit({ type: "agent_end", messages, willRetry: false });
        await subscription.waitForPendingEvents();

        const assistant = subscription.getCurrentAttemptAssistant();
        const attempt = makeEmbeddedRunnerAttempt({
          assistantTexts: subscription.assistantTexts,
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          lastAssistant: assistant,
          messagesSnapshot: messages,
          itemLifecycle: subscription.getItemLifecycle(),
          toolMetas: [
            { toolName: "read", toolCallId: "read-note", isError: false, replaySafe: true },
          ],
        });
        const payloads = buildSubscriptionPayloads(subscription);
        expect(subscription.assistantTexts).toEqual([markdown, "NO_REPLY"]);
        expect(attempt.itemLifecycle).toMatchObject({
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        });
        expect(delivered).toEqual(delivery === "immediate" ? [markdown] : []);
        expect(pending).toEqual(delivery === "pending" ? [markdown] : []);
        expect(subscription.getVisibleBlockReplyCount()).toBe(
          delivery === "immediate" || delivery === "pending" ? 1 : 0,
        );
        expect(payloads).toEqual([]);
        const replyDeliveryState =
          delivered.length > 0 ? "delivered" : pending.length > 0 ? "pending" : "missing";
        const finalizationRequest = resolveSettledTurnFinalizationRequest({
          runParams: {
            runId: "silent-tail",
            sessionId: "silent-tail",
            workspaceDir: "/synthetic",
            prompt: user.content,
            timeoutMs: 1000,
            terminalReplyExpectation: "required",
          },
          attempt,
          replyDeliveryState,
          activeErrorContext: { provider: "openai", model: "mock-1" },
          modelApi: "openai-responses",
          executionContract: undefined,
          payloadsWithToolMedia: payloads,
          hasTerminalToolPresentation: false,
          terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
          settledTurnFinalizationAvailable: true,
        });
        if (replyDeliveryState === "missing") {
          expect(finalizationRequest).toContain("Tools are unavailable");
        } else {
          expect(finalizationRequest).toBeNull();
        }
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it("subscribeEmbeddedAgentSession + buildEmbeddedRunPayloads seals only answered inputs", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "answered-inputs" });
    const first = makeAgentAssistantMessage({ content: [{ type: "text", text: "A" }] });
    const final = makeAgentAssistantMessage({ content: [{ type: "text", text: "B" }] });
    const initialUser = { role: "user", content: "Initial question", timestamp: 0 };
    const injectedUsers = ["Next question", "Additional detail"].map((content) => ({
      role: "user",
      content,
      timestamp: 0,
    }));
    try {
      emit({ type: "message_start", message: initialUser });
      emit({ type: "message_end", message: initialUser });
      emitAssistantMessage(emit, first);
      emit({ type: "turn_end", message: first, toolResults: [] });
      await subscription.waitForPendingEvents();
      expect(buildSubscriptionPayloads(subscription).map((payload) => payload.text)).toEqual(["A"]);
      expect(subscription.answerSegments).toHaveLength(0);

      for (const message of injectedUsers) {
        emit({ type: "message_start", message });
        emit({ type: "message_end", message });
      }
      emitAssistantMessage(emit, final);
      emit({ type: "turn_end", message: final, toolResults: [] });
      emit({
        type: "agent_end",
        messages: [initialUser, first, ...injectedUsers, final],
        willRetry: false,
      });
      await subscription.waitForPendingEvents();
      expect(subscription.answerSegments).toHaveLength(1);
      expect(buildSubscriptionPayloads(subscription).map((payload) => payload.text)).toEqual([
        "A",
        "B",
      ]);
    } finally {
      subscription.unsubscribe();
    }
  });

  it("subscribeEmbeddedAgentSession + buildEmbeddedRunPayloads agrees on final answers in sealed and open segments", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "sealed-progress",
      onBlockReply,
      onBeforeTerminalDelivery: async () => undefined,
      blockReplyBreak: "message_end",
    });
    const progress = makeAgentAssistantMessage({
      content: [
        { type: "text", text: "A1" },
        { type: "toolCall", id: "read-progress", name: "read", arguments: {} },
      ],
      stopReason: "toolUse",
    });
    const first = makeAgentAssistantMessage({ content: [{ type: "text", text: "A2" }] });
    const final = makeAgentAssistantMessage({ content: [{ type: "text", text: "A3" }] });
    const result = { content: [{ type: "text", text: "Read complete." }] };
    const toolResult = {
      role: "toolResult",
      toolCallId: "read-progress",
      toolName: "read",
      ...result,
      isError: false,
      timestamp: 0,
    };
    const user = { role: "user", content: "Next question", timestamp: 0 };
    try {
      emitAssistantMessage(emit, progress);
      emit({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "read-progress",
        args: {},
      });
      emit({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "read-progress",
        result,
        isError: false,
      });
      emit({ type: "message_start", message: toolResult });
      emit({ type: "message_end", message: toolResult });
      emit({ type: "turn_end", message: progress, toolResults: [toolResult] });
      emitAssistantMessage(emit, first);
      emit({ type: "turn_end", message: first, toolResults: [] });
      emit({ type: "message_start", message: user });
      emit({ type: "message_end", message: user });
      emitAssistantMessage(emit, final);
      emit({ type: "turn_end", message: final, toolResults: [] });
      emit({
        type: "agent_end",
        messages: [progress, toolResult, first, user, final],
        willRetry: false,
      });
      await subscription.waitForPendingEvents();
      expect(buildSubscriptionPayloads(subscription).map((payload) => payload.text)).toEqual([
        "A2",
        "A3",
      ]);
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual(["A2", "A3"]);
    } finally {
      subscription.unsubscribe();
    }
  });

  it.each([false, true])(
    "subscribeEmbeddedAgentSession + buildEmbeddedRunPayloads delivers each steered answer (deferred: %s)",
    async (deferred) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "steered-answers",
        onBlockReply: deferred ? onBlockReply : undefined,
        onBeforeTerminalDelivery: deferred ? async () => undefined : undefined,
        blockReplyBreak: "message_end",
      });
      const first = makeAgentAssistantMessage({
        content: [
          { type: "text", text: "A" },
          { type: "toolCall", id: "skipped-read", name: "read", arguments: {} },
        ],
        stopReason: "toolUse",
      });
      const final = makeAgentAssistantMessage({ content: [{ type: "text", text: "B" }] });
      const result = { content: [{ type: "text", text: "Skipped due to queued user message." }] };
      const toolResult = {
        role: "toolResult",
        toolCallId: "skipped-read",
        toolName: "read",
        ...result,
        isError: true,
        timestamp: 0,
      };
      const user = { role: "user", content: "Question B", timestamp: 0 };
      try {
        emitAssistantMessage(emit, first);
        emit({
          type: "tool_execution_start",
          toolName: "read",
          toolCallId: "skipped-read",
          args: {},
        });
        emit({
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "skipped-read",
          result,
          isError: true,
        });
        emit({ type: "turn_end", message: first, toolResults: [toolResult] });
        emit({ type: "message_start", message: user });
        emit({ type: "message_end", message: user });
        emitAssistantMessage(emit, final);
        emit({ type: "turn_end", message: final, toolResults: [] });
        emit({ type: "agent_end", messages: [first, toolResult, user, final], willRetry: false });
        await subscription.waitForPendingEvents();
        const payloads = buildSubscriptionPayloads(subscription);
        expect(payloads).toHaveLength(2);
        expect(payloads.map((payload) => payload.text)).toEqual(["A", "B"]);
        if (deferred) {
          expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual(["A", "B"]);
        }
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { terminalText: "Completed answer.", priorStopReason: "toolUse" },
    { terminalText: "NO_REPLY", priorStopReason: "toolUse" },
    { terminalText: "Completed answer.", priorStopReason: "stop" },
    { terminalText: "NO_REPLY", priorStopReason: "stop" },
  ] as const)(
    "supersedes deferred $priorStopReason tool-turn answers with terminal $terminalText",
    async ({ terminalText, priorStopReason }) => {
      const onBlockReply = vi.fn();
      const onPartialReply = vi.fn();
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-before-terminal-supersession",
        onBlockReply,
        onPartialReply,
        onAgentEvent,
        onBeforeTerminalDelivery: async () => undefined,
        blockReplyBreak: "message_end",
      });
      const messages = [
        "Obsolete preflight answer.",
        "Obsolete follow-up answer.",
        terminalText,
      ].map((text, index) =>
        makeAgentAssistantMessage({
          content: [
            {
              type: "text",
              text,
              textSignature: JSON.stringify({ v: 1, id: `answer-${index}`, phase: "final_answer" }),
            },
            ...(index < 2
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
          stopReason: index < 2 ? priorStopReason : "stop",
        }),
      );
      for (const [index, message] of messages.entries()) {
        emitAssistantMessage(emit, message);
        if (index < 2) {
          emit({
            type: "tool_execution_start",
            toolName: "read",
            toolCallId: `read-${index}`,
            args: {},
          });
          emit({
            type: "tool_execution_end",
            toolName: "read",
            toolCallId: `read-${index}`,
            isError: false,
            result: { content: [{ type: "text", text: "Successful result." }] },
          });
          emit({
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
        await subscription.waitForPendingEvents();
      }
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(onPartialReply).not.toHaveBeenCalled();
      expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);

      emit({ type: "agent_end", messages, willRetry: false });
      await subscription.waitForPendingEvents();

      const expected = terminalText === "NO_REPLY" ? [] : [terminalText];
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text).filter(Boolean)).toEqual(
        expected,
      );
      expect(onPartialReply.mock.calls.map(([payload]) => payload.text).filter(Boolean)).toEqual(
        expected,
      );
      expect(
        onAgentEvent.mock.calls
          .filter(([event]) => event.stream === "assistant")
          .map(([event]) => event.data.text)
          .filter(Boolean),
      ).toEqual(expected);
      expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(true);
      subscription.unsubscribe();
    },
  );

  it("subscribeEmbeddedAgentSession retains completed answers to earlier user inputs in the same run", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-followups",
      onBlockReply,
      onBeforeTerminalDelivery: async () => undefined,
      blockReplyBreak: "message_end",
    });
    const messages = ["First completed answer.", "Second completed answer."].map((text) =>
      makeAgentAssistantMessage({ content: [{ type: "text", text }] }),
    );
    for (const message of messages) {
      const user = { role: "user", content: "Next question", timestamp: 0 };
      emit({ type: "message_start", message: user });
      emit({ type: "message_end", message: user });
      emitAssistantMessage(emit, message);
      emit({ type: "turn_end", message, toolResults: [] });
    }
    emit({ type: "agent_end", messages, willRetry: false });
    await subscription.waitForPendingEvents();
    expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
      "First completed answer.",
      "Second completed answer.",
    ]);
    subscription.unsubscribe();
  });

  it.each(["Completed answer.", "NO_REPLY"])(
    "preserves deferred media and reasoning, but not obsolete captions, before %j",
    async (terminalText) => {
      const onBlockReply = vi.fn();
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-before-terminal-media-supersession",
        onBlockReply,
        onAgentEvent,
        onBeforeTerminalDelivery: async () => undefined,
        blockReplyBreak: "text_end",
        reasoningMode: "on",
        internalEvents: [
          {
            type: "task_completion",
            source: "music_generation",
            childSessionKey: "music_generate:generated-track",
            announceType: "music generation task",
            taskLabel: "generated track",
            status: "ok",
            statusLabel: "completed successfully",
            result: "Generated a track.",
            mediaUrls: ["/tmp/generated.opus"],
            attachments: [
              { path: "/tmp/generated.opus", mimeType: "audio/ogg", name: "generated.opus" },
            ],
            replyInstruction: "Reply normally.",
          },
        ],
      });
      const mediaMessage = makeAgentAssistantMessage({
        content: [
          {
            type: "text",
            text: "Obsolete caption.\nMEDIA:/tmp/generated.opus",
            textSignature: JSON.stringify({ v: 1, id: "media", phase: "final_answer" }),
          },
        ],
        stopReason: "toolUse",
      });
      const commentary = makeAgentAssistantMessage({
        content: [
          { type: "thinking", thinking: "Checking the generated track." },
          {
            type: "text",
            text: "Checking current state.",
            textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
          },
        ],
        stopReason: "toolUse",
      });
      const final = makeAgentAssistantMessage({
        content: (terminalText === "NO_REPLY"
          ? [terminalText]
          : [terminalText, "Second answer block."]
        ).map((text, index) => ({
          type: "text",
          text,
          textSignature: JSON.stringify({ v: 1, id: `final-${index}`, phase: "final_answer" }),
        })),
      });
      for (const message of [mediaMessage, commentary, final]) {
        emitAssistantMessage(emit, message);
        await subscription.waitForPendingEvents();
      }
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: "item",
        data: expect.objectContaining({
          kind: "preamble",
          progressText: "Checking current state.",
        }),
      });
      emit({ type: "agent_end", messages: [mediaMessage, commentary, final], willRetry: false });
      await subscription.waitForPendingEvents();

      const payloads = onBlockReply.mock.calls.map(([payload]) => payload);
      const mediaPayloads = payloads.filter((payload) => payload.mediaUrls?.length);
      expect(mediaPayloads).toHaveLength(1);
      expect(mediaPayloads[0]).toMatchObject({
        mediaUrls: ["/tmp/generated.opus"],
        trustedLocalMedia: true,
        attachments: [
          {
            path: "/tmp/generated.opus",
            mimeType: "audio/ogg",
            name: "generated.opus",
            trustedLocalMedia: true,
          },
        ],
      });
      expect(mediaPayloads[0].text ?? "").toBe("");
      expect(getReplyPayloadMetadata(mediaPayloads[0])).toMatchObject({
        assistantTranscriptMediaUrls: ["/tmp/generated.opus"],
      });
      expect(
        payloads.filter((payload) => payload.isReasoning).map((payload) => payload.text),
      ).toEqual(["Checking the generated track."]);
      expect(
        payloads
          .filter((payload) => !payload.isReasoning)
          .map((payload) => payload.text)
          .filter(Boolean),
      ).toEqual(terminalText === "NO_REPLY" ? [] : [terminalText, "Second answer block."]);
      const assistantEvents = onAgentEvent.mock.calls.filter(
        ([event]) => event.stream === "assistant",
      );
      expect(assistantEvents.some(([event]) => event.data.text.includes("Obsolete"))).toBe(false);
      expect(
        assistantEvents
          .filter(([event]) => event.data.mediaUrls?.length)
          .map(([event]) => event.data),
      ).toEqual([expect.objectContaining({ text: "", mediaUrls: ["/tmp/generated.opus"] })]);
      expect(subscription.hasToolMediaBlockReply()).toBe(true);
      expect(subscription.getPendingToolMediaReply()).toBeNull();
      subscription.unsubscribe();
    },
  );

  it.each([false, true])(
    "retains the complete final prefix when earlier text was deferred (stream: %s)",
    async (stream) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-before-terminal-prefix",
        onBlockReply,
        onBeforeTerminalDelivery: async () => undefined,
        blockReplyBreak: "text_end",
      });
      const first = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Result:" }],
        stopReason: "toolUse",
      });
      emitAssistantMessage(emit, first, stream);
      emit({ type: "tool_execution_start", toolName: "read", toolCallId: "read-prefix", args: {} });
      emit({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "read-prefix",
        isError: false,
        result: { content: [{ type: "text", text: "OK" }] },
      });
      const final = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Result:complete" }],
      });
      emitAssistantMessage(emit, final, stream);
      emit({ type: "agent_end", messages: [first, final], willRetry: false });
      await subscription.waitForPendingEvents();
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual(["Result:complete"]);
      subscription.unsubscribe();
    },
  );
});
