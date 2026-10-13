import { expectDefined } from "@openclaw/normalization-core";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import * as agentEvents from "../infra/agent-events.js";
import {
  createSubscribedSessionHarness,
  emitAssistantLifecycleErrorAndEnd,
  emitMessageStartAndEndForAssistantText,
  emitToolRun,
  extractAgentEventPayloads,
  findLifecycleErrorAgentEvent,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";
import { markCoreTtsToolResult } from "./tools/tts-tool-result-provenance.js";
import { makeZeroUsageSnapshot } from "./usage.js";

type BlockReply = NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>;
type ToolResult = NonNullable<SubscribeEmbeddedAgentSessionParams["onToolResult"]>;

const retryingCompactionEnd = () =>
  ({
    type: "compaction_end",
    reason: "overflow",
    outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
  }) as const;

function completion(source: "music_generation" | "subagent", mediaUrl: string) {
  return {
    type: "task_completion" as const,
    source,
    childSessionKey: source === "subagent" ? "agent:child:main" : "music_generate:task-123",
    announceType: "completed task",
    taskLabel: "media",
    status: "ok" as const,
    statusLabel: "completed successfully",
    result: "Media ready.",
    mediaUrls: [mediaUrl],
    replyInstruction: "Reply normally.",
  };
}

function emitOrphanedVoice(emit: (event: unknown) => void) {
  emit({
    type: "tool_execution_end",
    toolName: "tts",
    toolCallId: "tc-1",
    isError: false,
    result: markCoreTtsToolResult(
      {
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
            trustedLocalMedia: true,
          },
        },
      },
      ["/tmp/reply.opus"],
    ),
  });
}

describe("subscribeEmbeddedAgentSession", () => {
  it.each([1, 17, 1210])(
    "delivers intact graphemes from %i-character provider deltas",
    async (deltaSize) => {
      const cluster = "👨‍👩‍👧‍👦";
      const source = `${"x".repeat(1195)}${cluster}done`;
      const codePoints = Array.from(source);
      const onBlockReply = vi.fn<BlockReply>();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "grapheme-boundary",
        onBlockReply,
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 800, maxChars: 1200, breakPreference: "paragraph" },
      });
      try {
        let text = "";
        for (let offset = 0; offset < codePoints.length; offset += deltaSize) {
          const delta = codePoints.slice(offset, offset + deltaSize).join("");
          text += delta;
          emit(
            createOpenAiResponsesTextEvent({
              type: "text_delta",
              text,
              delta,
              id: "grapheme-answer",
              signaturePhase: "final_answer",
            }),
          );
        }
        emit(
          createOpenAiResponsesTextEvent({
            type: "text_end",
            text: source,
            id: "grapheme-answer",
            signaturePhase: "final_answer",
          }),
        );
        emit({ type: "agent_end", messages: [], willRetry: false });
        await subscription.waitForPendingEvents();

        const chunks = onBlockReply.mock.calls.map(([reply]) => reply.text ?? "");
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join("")).toBe(source);
        expect(chunks.filter((chunk) => chunk.includes(cluster))).toHaveLength(1);
        expect(chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  function createAgentEventHarness(options?: { runId?: string; sessionKey?: string }) {
    const onAgentEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: options?.runId ?? "run",
      onAgentEvent,
      sessionKey: options?.sessionKey,
    });

    return { emit, onAgentEvent };
  }

  function createToolErrorHarness(runId: string) {
    return createSubscribedSessionHarness({
      runId,
      sessionKey: "test-session",
    });
  }

  function emitAssistantTextDelta(
    emit: (evt: unknown) => void,
    delta: string,
    message: Record<string, unknown> = { role: "assistant" },
  ) {
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        delta,
      },
    });
  }

  function emitThinkingEvent(
    emit: (evt: unknown) => void,
    thinking: string,
    assistantMessageEvent: { type: "thinking_delta"; delta: string } | { type: "thinking_end" },
  ) {
    emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking }] },
      assistantMessageEvent,
    });
  }

  async function createGeneratedImageHarness(
    options: Pick<
      Parameters<typeof createSubscribedSessionHarness>[0],
      "blockReplyBreak" | "blockReplyChunking"
    > = {},
  ) {
    const onToolResult = vi.fn<ToolResult>();
    const onBlockReply = vi.fn<BlockReply>();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onToolResult,
      onBlockReply,
      verboseLevel: "full",
      blockReplyBreak: "message_end",
      builtinToolNames: new Set(["image_generate"]),
      ...options,
    });
    emitToolRun({
      emit,
      toolName: "image_generate",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
          },
        ],
        details: { media: { mediaUrls: ["/tmp/generated.png"] } },
      },
    });
    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(2);
    });
    return { emit, subscription, onToolResult, onBlockReply };
  }

  function expectBlockReplyPayload(
    onBlockReply: ReturnType<typeof vi.fn<BlockReply>>,
    expected: { text: string; mediaUrls?: string[]; trustedLocalMedia?: boolean },
  ) {
    const payload = expectDefined(
      onBlockReply.mock.calls.find(([reply]) => reply.text === expected.text)?.[0],
      "expected matching block reply",
    );
    if (expected.mediaUrls !== undefined) {
      expect(payload.mediaUrls).toStrictEqual(expected.mediaUrls);
    }
    expect(payload.trustedLocalMedia).toBe(expected.trustedLocalMedia);
  }

  it("delivers generated media after dropping malformed provider attachment metadata", async () => {
    const onBlockReply = vi.fn<BlockReply>();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "generated-malformed-metadata",
      onBlockReply,
      blockReplyBreak: "message_end",
      builtinToolNames: new Set(["music_generate"]),
    });
    const mediaPath = "/tmp/generated-song.mp3";

    emitToolRun({
      emit,
      toolName: "music_generate",
      toolCallId: "music-tool",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated media." }],
        details: {
          media: {
            mediaUrls: [mediaPath],
            attachments: [
              { type: "audio", path: mediaPath, name: 1, mimeType: null, durationMs: -1 },
            ],
          },
        },
      },
    });
    await subscription.waitForPendingEvents();
    emitMessageStartAndEndForAssistantText({ emit, text: "Here is your generated song." });
    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({
      text: "Here is your generated song.",
      mediaUrls: [mediaPath],
      attachments: [{ type: "audio", path: mediaPath }],
    });
  });

  it("blocks local MEDIA urls from case-variant tool names in verbose output", async () => {
    const onToolResult = vi.fn<ToolResult>();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onToolResult,
      verboseLevel: "full",
      builtinToolNames: new Set(["web_search"]),
    });

    emitToolRun({
      emit,
      toolName: "Web_Search",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Fetched page\nMEDIA:/tmp/secret.png" }],
      },
    });

    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(2);
    });
    const payload = expectDefined(onToolResult.mock.calls.at(-1)?.[0], "expected tool result");
    expect(payload.text ?? "").toContain("Fetched page");
    expect(payload.mediaUrls).toBeUndefined();
  });

  it("delivers generated attachment metadata with the assistant reply", async () => {
    const onBlockReply = vi.fn<BlockReply>();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "generated-video",
      onBlockReply,
      blockReplyBreak: "message_end",
      builtinToolNames: new Set(["video_generate"]),
    });
    const attachment = {
      type: "video",
      path: "/tmp/generated-video",
      name: "friendly-video",
      mimeType: "video/mp4",
      sizeBytes: 137,
      durationMs: 5_000,
      width: 1280,
      height: 720,
    };

    emitToolRun({
      emit,
      toolName: "video_generate",
      toolCallId: "video-tool",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated media." }],
        details: { media: { mediaUrls: [attachment.path], attachments: [attachment] } },
      },
    });
    await subscription.waitForPendingEvents();
    expect(subscription.getPendingToolMediaReply()).toMatchObject({
      mediaUrls: [attachment.path],
      attachments: [attachment],
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Here is your generated file." });
    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({
      text: "Here is your generated file.",
      mediaUrls: [attachment.path],
      attachments: [attachment],
    });
  });

  it("delivers the caption and selected media once when terminal media follows an ended Responses block", async () => {
    const { emit, subscription, onBlockReply } = await createGeneratedImageHarness({
      blockReplyBreak: "text_end",
    });
    const caption = "Here is the selected image.";
    const first = { text: caption, id: "caption", signaturePhase: "final_answer" as const };
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const type of ["text_delta", "text_end"] as const) {
      emit(createOpenAiResponsesTextEvent({ type, ...first }));
    }
    const message = createOpenAiResponsesPartial(first);
    message.content.push(
      createOpenAiResponsesTextBlock({
        text: "MEDIA:./selected.png",
        id: "media",
        phase: "final_answer",
      }),
    );
    emit({ type: "message_end", message });
    await subscription.waitForPendingEvents();
    const payloads = onBlockReply.mock.calls.map(([payload]) => payload);
    expect({
      captions: payloads.map((payload) => payload.text).filter(Boolean),
      mediaUrls: payloads.flatMap((payload) => payload.mediaUrls ?? []),
    }).toEqual({ captions: [caption], mediaUrls: ["./selected.png"] });
  });

  it("does not attach generated image media to an early streamed chunk before explicit MEDIA", async () => {
    const { emit, subscription, onBlockReply } = await createGeneratedImageHarness({
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 5, maxChars: 200, breakPreference: "newline" },
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "Generated 1 image.\n");
    await subscription.waitForPendingEvents();

    expectBlockReplyPayload(onBlockReply, {
      text: "Generated 1 image.",
    });
    const earlyMediaPayloads = onBlockReply.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.mediaUrls?.length);
    expect(earlyMediaPayloads).toStrictEqual([]);

    emitAssistantTextDelta(emit, "MEDIA:/tmp/generated.png");
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Generated 1 image.\nMEDIA:/tmp/generated.png",
      },
    });
    emit({
      type: "message_end",
      message: textAssistant("Generated 1 image.\nMEDIA:/tmp/generated.png"),
    });
    emit({ type: "agent_end" });
    await subscription.waitForPendingEvents();

    const mediaPayloads = onBlockReply.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.mediaUrls?.includes("/tmp/generated.png"));
    expect(mediaPayloads).toHaveLength(1);
    expect(subscription.hasToolMediaBlockReply()).toBe(true);
  });

  it("does not trust a mixed generated and non-generated pending media batch", async () => {
    const onBlockReply = vi.fn<BlockReply>();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      internalEvents: [
        completion("music_generation", "/tmp/generated.mp3"),
        completion("subagent", "/tmp/untrusted.mp3"),
      ],
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    });
    emit({ type: "agent_end" });
    await subscription.waitForPendingEvents();

    expectBlockReplyPayload(onBlockReply, {
      text: "Done.",
      mediaUrls: ["/tmp/generated.mp3", "/tmp/untrusted.mp3"],
      trustedLocalMedia: undefined,
    });
  });

  it("counts orphaned tool media emitted through block replies", async () => {
    const onBlockReply = vi.fn<BlockReply>();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      builtinToolNames: new Set(["tts"]),
      coreBuiltinToolNames: new Set(["tts"]),
      sourceReplyDeliveryMode: "message_tool_only",
      onBlockReply,
    });

    emitOrphanedVoice(emit);
    emit({ type: "agent_end" });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledWith({
      mediaUrls: ["/tmp/reply.opus"],
      mediaUrl: "/tmp/reply.opus",
      attachments: [{ trustedLocalMedia: true }],
      audioAsVoice: true,
      trustedLocalMedia: true,
    });
    expect(subscription.getPendingToolMediaReply()).toBeNull();
    expect(subscription.getToolAutoDeliveryMediaUrls()).toEqual([]);
    expect(subscription.hasToolMediaBlockReply()).toBe(true);
    expect(subscription.getVisibleBlockReplyCount()).toBe(1);
    expect(getReplyPayloadMetadata(onBlockReply.mock.calls[0]?.[0] ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it.each([{ label: "commentary", stopReason: "stop", phase: "commentary" }] as const)(
    "closes a reasoning preview before the $label message ends without thinking_end",
    ({ stopReason, phase }) => {
      const visibleEvents: string[] = [];
      const onReasoningEnd = vi.fn(async () => {
        visibleEvents.push("reasoning-end");
      });
      const { emit } = createSubscribedSessionHarness({
        runId: "run-reasoning-terminal",
        reasoningMode: "stream",
        onReasoningStream: vi.fn(),
        onReasoningEnd,
        onAgentEvent: (event) => {
          if (event.stream === "assistant") {
            visibleEvents.push("assistant");
          }
        },
      });
      const thinkingMessage = {
        role: "assistant" as const,
        content: [{ type: "thinking" as const, thinking: "Checking files" }],
      };

      emit({ type: "message_start", message: thinkingMessage });
      emit({
        type: "message_update",
        message: thinkingMessage,
        assistantMessageEvent: { type: "thinking_delta", delta: "Checking files" },
      });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason,
          ...(phase ? { phase } : {}),
          content: [
            { type: "thinking", thinking: "Checking files" },
            { type: "text", text: "Final answer" },
          ],
        },
      });

      expect(onReasoningEnd).toHaveBeenCalledTimes(1);
      expect(visibleEvents[0]).toBe("reasoning-end");
    },
  );

  it.each([false, true])("gates off-mode reasoning streaming with opt-in=%s", (enabled) => {
    const onReasoningStream = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      reasoningMode: "off",
      streamReasoningInNonStreamModes: enabled,
      onReasoningStream,
    });
    emitThinkingEvent(emit, "Checking files", { type: "thinking_delta", delta: "Checking files" });
    if (enabled) {
      expect(onReasoningStream).toHaveBeenCalledWith({
        text: "Checking files",
        requiresReasoningProgressOptIn: true,
      });
    } else {
      expect(onReasoningStream).not.toHaveBeenCalled();
    }
  });

  it("emits live edit diff progress while tool arguments stream", () => {
    const emitAgentEventSpy = vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(() => {});
    const { emit } = createSubscribedSessionHarness({ runId: "run-live-edit-diff" });
    const partialJson =
      '{"path":"notes.md","edits":[{"oldText":"old\\nline","newText":"new\\nline\\n';
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tool-live-edit",
          name: "edit",
          arguments: {},
          partialJson,
        },
      ],
    };

    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: partialJson,
        partial: message,
      },
    });

    expect(
      emitAgentEventSpy.mock.calls
        .map(([event]) => event)
        .find((event) => event.stream === "tool" && event.data?.phase === "input_delta"),
    ).toMatchObject({
      runId: "run-live-edit-diff",
      stream: "tool",
      data: {
        phase: "input_delta",
        toolCallId: "tool-live-edit",
        name: "edit",
        diff: { added: 2, removed: 1 },
      },
    });
    emitAgentEventSpy.mockRestore();
  });

  it("emits reasoning end once when native and tagged reasoning end overlap", () => {
    const onReasoningEnd = vi.fn();

    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream: vi.fn(),
      onReasoningEnd,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta(emit, "<think>Checking");
    emitThinkingEvent(emit, "Checking", { type: "thinking_end" });

    emitAssistantTextDelta(emit, " files</think>\nFinal answer");

    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it.each<{
    name: string;
    chunks: string[];
    expected?: Array<Record<string, unknown>>;
    last?: Record<string, unknown>;
    messageEnd?: string;
    noReplacement?: boolean;
  }>([
    {
      name: "preserves media directives when orphan close replacement has no text",
      chunks: ["private chain of thought </thi", "nk>\nMEDIA:/tmp/a.png\n"],
      messageEnd: "private chain of thought </think>\nMEDIA:/tmp/a.png\n",
      last: { text: "", mediaUrls: ["/tmp/a.png"] },
      noReplacement: true,
    },
    {
      name: "keeps close tag literals inside hidden fenced code stripped across deltas",
      chunks: ["<think>\n```ts\nliteral ", "</think> still private"],
      expected: [],
    },
  ])("$name", (scenario) => {
    const { emit, onAgentEvent } = createAgentEventHarness();
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const chunk of scenario.chunks) {
      emitAssistantTextDelta(emit, chunk);
    }
    if (scenario.messageEnd !== undefined) {
      emit({
        type: "message_end",
        message: textAssistant(scenario.messageEnd),
      });
    }
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    if (scenario.expected !== undefined) {
      expect(payloads).toHaveLength(scenario.expected.length);
      expect(payloads).toMatchObject(scenario.expected);
    }
    if (scenario.last !== undefined) {
      expect(payloads.at(-1)).toMatchObject(scenario.last);
    }
    if (scenario.noReplacement) {
      expect(payloads.at(-1)?.replace).toBeUndefined();
    }
  });

  it.each([
    { replyToId: "new-target", text: "Corrected", terminal: "text_end" },
    { replyToId: undefined, text: "Draft", terminal: "text_end" },
    {
      replyToId: undefined,
      text: "Corrected",
      terminal: "message_end",
      priorText: "First block.",
    },
  ])(
    "replaces pending reply directives with authoritative checkpoint target %j",
    async ({ replyToId, text, terminal, priorText = "" }) => {
      const onBlockReply = vi.fn<BlockReply>();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-directive-replacement",
        onBlockReply,
        blockReplyBreak: terminal === "message_end" && !priorText ? "message_end" : "text_end",
        blockReplyChunking:
          terminal === "message_end"
            ? { minChars: 200, maxChars: 200, breakPreference: "sentence" }
            : undefined,
      });
      try {
        emit({ type: "message_start", message: { role: "assistant" } });
        if (priorText) {
          for (const type of ["text_delta", "text_end"] as const) {
            emit(
              createOpenAiResponsesTextEvent({
                type,
                text: priorText,
                id: "prior-answer",
                signaturePhase: "final_answer",
              }),
            );
          }
          await subscription.waitForPendingEvents();
          expect(onBlockReply.mock.calls.map(([reply]) => reply.text)).toEqual([priorText]);
        }
        emit(
          createOpenAiResponsesTextEvent({
            type: "text_delta",
            text: "[[reply_to:old-target]] [[audio_as_voice]] Draft",
            id: "answer",
            signaturePhase: "final_answer",
          }),
        );
        expect(onBlockReply).toHaveBeenCalledTimes(priorText ? 1 : 0);
        const checkpoint = {
          text: `${replyToId ? `[[reply_to:${replyToId}]] ` : ""}${text}`,
          id: "answer",
          signaturePhase: "final_answer" as const,
        };
        if (terminal === "message_end") {
          const message = createOpenAiResponsesPartial(checkpoint);
          if (priorText) {
            message.content.unshift(
              createOpenAiResponsesTextBlock({
                text: priorText,
                id: "prior-answer",
                phase: "final_answer",
              }),
            );
          }
          emit({ type: "message_end", message });
        } else {
          emit(createOpenAiResponsesTextEvent({ type: "text_end", ...checkpoint }));
        }
        await subscription.waitForPendingEvents();

        expect(onBlockReply.mock.calls.map(([reply]) => reply.text)).toEqual(
          priorText ? [priorText, text] : [text],
        );
        const reply = expectDefined(onBlockReply.mock.calls.at(-1)?.[0], "corrected block reply");
        expect({
          text: reply.text,
          replyToId: reply.replyToId,
          replyToTag: Boolean(reply.replyToTag),
          audioAsVoice: Boolean(reply.audioAsVoice),
        }).toEqual({
          text,
          replyToId,
          replyToTag: Boolean(replyToId),
          audioAsVoice: false,
        });
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it("keeps unresolved mutating failure when an unrelated tool succeeds", async () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-1");
    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/demo.txt", content: "next" },
      isError: true,
      result: { error: "disk full" },
    });
    expect(subscription.getLastToolError()?.toolName).toBe("write");

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "r1",
      args: { path: "/tmp/demo.txt" },
      isError: false,
      result: { text: "ok" },
    });

    await subscription.waitForPendingEvents();
    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("preserves distinct mutation failures through compaction until each action recovers", async () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-compaction-retry");

    for (const [toolCallId, filePath] of [
      ["write-a-failed", "/tmp/a.txt"],
      ["write-b-failed", "/tmp/b.txt"],
    ] as const) {
      emitToolRun({
        emit,
        toolName: "write",
        toolCallId,
        args: { path: filePath, content: "next" },
        isError: true,
        result: { error: "disk full" },
      });
    }

    emit(retryingCompactionEnd());
    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "write-b-recovered",
      args: { path: "/tmp/b.txt", content: "retry" },
      isError: false,
      result: { ok: true },
    });

    await subscription.waitForPendingEvents();
    expect(subscription.getLastToolError()).toBeUndefined();

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "write-a-recovered",
      args: { path: "/tmp/a.txt", content: "retry" },
      isError: false,
      result: { ok: true },
    });

    await subscription.waitForPendingEvents();
    expect(subscription.getLastToolError()).toBeUndefined();
  });

  it("emits lifecycle:error event on agent_end when last assistant message was an error", () => {
    const { emit, onAgentEvent } = createAgentEventHarness({
      runId: "run-error",
      sessionKey: "test-session",
    });

    emitAssistantLifecycleErrorAndEnd({
      emit,
      errorMessage: "429 Rate limit exceeded",
    });
    const lifecycleError = findLifecycleErrorAgentEvent(onAgentEvent.mock.calls);

    if (!lifecycleError) {
      throw new Error("Expected lifecycle error event");
    }
    const error = (lifecycleError.data as { error?: unknown } | undefined)?.error;
    expect(typeof error).toBe("string");
    expect(error).toContain("The AI service needs a short break");
  });

  it("reads terminal abort state before emitting lifecycle:end", () => {
    const onAgentEvent = vi.fn();
    let terminalAborted = false;
    const { emit } = createSubscribedSessionHarness({
      runId: "run-aborted",
      sessionKey: "test-session",
      onAgentEvent,
      isTerminalAborted: () => terminalAborted,
    });
    const assistantMessage = {
      api: "test",
      provider: "test",
      model: "test",
      role: "assistant",
      stopReason: "aborted",
      content: [],
      usage: makeZeroUsageSnapshot(),
      timestamp: 0,
    } as AssistantMessage;

    emit({ type: "message_start", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });
    terminalAborted = true;
    emit({ type: "agent_end", messages: [assistantMessage] });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        phase: "end",
        stopReason: "aborted",
        aborted: true,
      }),
    );
  });

  it.each([
    {
      toolName: "edit",
      args: { file_path: "/tmp/demo.txt", old_string: "before", new_string: "after" },
      result: { ok: true },
      livenessState: "abandoned",
    },
    {
      toolName: "cron",
      args: { action: "add", job: { name: "reminder" } },
      result: { details: { status: "ok" } },
      livenessState: "working",
    },
    {
      toolName: "sessions_spawn",
      args: { prompt: "continue in a child session" },
      result: {
        details: {
          status: "accepted",
          runId: "run-child",
          childSessionKey: "agent:claude:subagent:child",
          expectsCompletionMessage: true,
        },
      },
      livenessState: "working",
    },
  ])(
    "preserves $toolName terminal evidence across compaction retries",
    async ({ toolName, args, result, livenessState }) => {
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `run-${toolName}-compaction-evidence`,
        sessionKey: toolName === "cron" ? undefined : "test-session",
        onAgentEvent,
      });
      emitToolRun({ emit, toolName, toolCallId: "side-effect", args, result, isError: false });
      await subscription.waitForPendingEvents();
      if (toolName === "cron") {
        expect(subscription.getSuccessfulCronAdds()).toBe(1);
      }
      emit(retryingCompactionEnd());
      await subscription.waitForPendingEvents();
      if (toolName === "cron") {
        expect(subscription.isCompacting()).toBe(true);
        expect(subscription.getSuccessfulCronAdds()).toBe(1);
      } else if (toolName === "sessions_spawn") {
        expect(subscription.getAcceptedSessionSpawns()).toEqual([
          {
            runId: "run-child",
            childSessionKey: "agent:claude:subagent:child",
            expectsCompletionMessage: true,
          },
        ]);
      }
      emit({ type: "agent_end" });
      await subscription.waitForPendingEvents();
      if (toolName === "edit") {
        expect(subscription.getReplayState()).toEqual({
          replayInvalid: true,
          hadPotentialSideEffects: true,
        });
      }
      expect(extractAgentEventPayloads(onAgentEvent.mock.calls)).toContainEqual(
        expect.objectContaining({ phase: "end", livenessState, replayInvalid: true }),
      );
    },
  );
});
