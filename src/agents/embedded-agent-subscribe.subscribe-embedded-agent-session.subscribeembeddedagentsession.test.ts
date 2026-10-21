import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
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
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";
import { markCoreTtsToolResult } from "./tools/tts-tool-result-provenance.js";

type BlockReply = NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>;
type ToolResult = NonNullable<SubscribeEmbeddedAgentSessionParams["onToolResult"]>;

function emitMessage(
  emit: (event: unknown) => void,
  type: "message_start" | "message_end",
  message: unknown = { role: "assistant" },
) {
  emit({ type, message });
}

function emitUpdate(
  emit: (event: unknown) => void,
  message: unknown,
  assistantMessageEvent: unknown,
) {
  emit({ type: "message_update", message, assistantMessageEvent });
}

type SessionOptions = Parameters<typeof createSubscribedSessionHarness>[0];
function blockReplyHarness(options: Omit<SessionOptions, "runId"> & { runId?: string } = {}) {
  const onBlockReply = vi.fn<BlockReply>();
  return {
    ...createSubscribedSessionHarness({ runId: "run", onBlockReply, ...options }),
    onBlockReply,
  };
}

function emitResponsesText(
  emit: (event: unknown) => void,
  type: "text_delta" | "text_end",
  text: string,
  id: string,
  delta?: string,
) {
  emit(createOpenAiResponsesTextEvent({ type, text, id, delta, signaturePhase: "final_answer" }));
}

function runTool(
  emit: (event: unknown) => void,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown> | undefined,
  result: unknown,
  isError = false,
) {
  emitToolRun({ emit, toolName, toolCallId, args, result, isError });
}

function thinkingMessage(thinking: string) {
  return { role: "assistant", content: [{ type: "thinking", thinking }] };
}

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
  const media = { mediaUrl: "/tmp/reply.opus", audioAsVoice: true, trustedLocalMedia: true };
  emit({
    type: "tool_execution_end",
    toolName: "tts",
    toolCallId: "tc-1",
    isError: false,
    result: markCoreTtsToolResult({ details: { media } }, [media.mediaUrl]),
  });
}

it("delivers intact graphemes from 1-character provider deltas", async () => {
  const cluster = "👨‍👩‍👧‍👦";
  const source = `${"x".repeat(1195)}${cluster}done`;
  const codePoints = Array.from(source);
  const { emit, subscription, onBlockReply } = blockReplyHarness({
    blockReplyBreak: "text_end",
    blockReplyChunking: { minChars: 800, maxChars: 1200, breakPreference: "paragraph" },
  });
  try {
    let text = "";
    for (const delta of codePoints) {
      text += delta;
      emitResponsesText(emit, "text_delta", text, "grapheme-answer", delta);
    }
    emitResponsesText(emit, "text_end", source, "grapheme-answer");
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
});

function createAgentEventHarness(
  options: Omit<SessionOptions, "runId" | "onAgentEvent"> & { runId?: string } = {},
) {
  const onAgentEvent = vi.fn();
  return {
    ...createSubscribedSessionHarness({ runId: "run", onAgentEvent, ...options }),
    onAgentEvent,
  };
}

function createToolErrorHarness(runId: string) {
  const harness = createSubscribedSessionHarness({ runId, sessionKey: "test-session" });
  return {
    ...harness,
    fail: (id: string, path: string) =>
      runTool(harness.emit, "write", id, { path, content: "next" }, { error: "disk full" }, true),
    recover: (id: string, path: string) =>
      runTool(harness.emit, "write", id, { path, content: "retry" }, { ok: true }),
  };
}

function emitAssistantTextDelta(emit: (evt: unknown) => void, delta: string) {
  emitUpdate(emit, { role: "assistant" }, { type: "text_delta", delta });
}

function emitThinkingEvent(
  emit: (evt: unknown) => void,
  thinking: string,
  assistantMessageEvent: { type: "thinking_delta"; delta: string } | { type: "thinking_end" },
) {
  emitUpdate(emit, thinkingMessage(thinking), assistantMessageEvent);
}

async function createGeneratedImageHarness(
  options: Pick<SessionOptions, "blockReplyBreak" | "blockReplyChunking"> = {},
) {
  const onToolResult = vi.fn<ToolResult>();
  const { emit, subscription, onBlockReply } = blockReplyHarness({
    onToolResult,
    verboseLevel: "full",
    blockReplyBreak: "message_end",
    builtinToolNames: new Set(["image_generate"]),
    ...options,
  });
  runTool(emit, "image_generate", "tool-1", undefined, {
    content: [{ type: "text", text: "Generated image.\nMEDIA:/tmp/generated.png" }],
    details: { media: { mediaUrls: ["/tmp/generated.png"] } },
  });
  await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledTimes(2));
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

it("blocks local MEDIA urls from case-variant tool names in verbose output", async () => {
  const onToolResult = vi.fn<ToolResult>();
  const { emit } = createSubscribedSessionHarness({
    runId: "run",
    onToolResult,
    verboseLevel: "full",
    builtinToolNames: new Set(["web_search"]),
  });
  runTool(emit, "Web_Search", "tool-1", undefined, {
    content: [{ type: "text", text: "Fetched page\nMEDIA:/tmp/secret.png" }],
  });
  await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledTimes(2));
  const payload = expectDefined(onToolResult.mock.calls.at(-1)?.[0], "expected tool result");
  expect(payload.text ?? "").toContain("Fetched page");
  expect(payload.mediaUrls).toBeUndefined();
});

it("delivers generated attachment metadata with the assistant reply", async () => {
  const { emit, subscription, onBlockReply } = blockReplyHarness({
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
  runTool(emit, "video_generate", "video-tool", undefined, {
    content: [{ type: "text", text: "Generated media." }],
    details: { media: { mediaUrls: [attachment.path], attachments: [attachment] } },
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
  emitMessage(emit, "message_start");
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
  emitMessage(emit, "message_end", message);
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
  emitMessage(emit, "message_start");
  emitAssistantTextDelta(emit, "Generated 1 image.\n");
  await subscription.waitForPendingEvents();
  expectBlockReplyPayload(onBlockReply, { text: "Generated 1 image." });
  const earlyMediaPayloads = onBlockReply.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload.mediaUrls?.length);
  expect(earlyMediaPayloads).toStrictEqual([]);
  emitAssistantTextDelta(emit, "MEDIA:/tmp/generated.png");
  emitUpdate(
    emit,
    { role: "assistant" },
    { type: "text_end", content: "Generated 1 image.\nMEDIA:/tmp/generated.png" },
  );
  emitMessage(emit, "message_end", textAssistant("Generated 1 image.\nMEDIA:/tmp/generated.png"));
  emit({ type: "agent_end" });
  await subscription.waitForPendingEvents();
  const mediaPayloads = onBlockReply.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload.mediaUrls?.includes("/tmp/generated.png"));
  expect(mediaPayloads).toHaveLength(1);
  expect(subscription.hasToolMediaBlockReply()).toBe(true);
});

it("does not trust a mixed generated and non-generated pending media batch", async () => {
  const { emit, subscription, onBlockReply } = blockReplyHarness({
    blockReplyBreak: "message_end",
    internalEvents: [
      completion("music_generation", "/tmp/generated.mp3"),
      completion("subagent", "/tmp/untrusted.mp3"),
    ],
  });
  emitMessage(emit, "message_start");
  emitMessage(emit, "message_end", {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
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
  const { emit, subscription, onBlockReply } = blockReplyHarness({
    builtinToolNames: new Set(["tts"]),
    coreBuiltinToolNames: new Set(["tts"]),
    sourceReplyDeliveryMode: "message_tool_only",
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

it("closes a reasoning preview before the commentary message ends without thinking_end", () => {
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
  const thinking = thinkingMessage("Checking files");
  emitMessage(emit, "message_start", thinking);
  emitUpdate(emit, thinking, { type: "thinking_delta", delta: "Checking files" });
  emitMessage(emit, "message_end", {
    role: "assistant",
    stopReason: "stop",
    phase: "commentary",
    content: [...thinking.content, { type: "text", text: "Final answer" }],
  });
  expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  expect(visibleEvents[0]).toBe("reasoning-end");
});

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
    content: [{ type: "toolCall", id: "tool-live-edit", name: "edit", arguments: {}, partialJson }],
  };
  emitUpdate(emit, message, {
    type: "toolcall_delta",
    contentIndex: 0,
    delta: partialJson,
    partial: message,
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
  emitMessage(emit, "message_start");
  emitAssistantTextDelta(emit, "<think>Checking");
  emitThinkingEvent(emit, "Checking", { type: "thinking_end" });
  emitAssistantTextDelta(emit, " files</think>\nFinal answer");
  expect(onReasoningEnd).toHaveBeenCalledTimes(1);
});

function hiddenTextEvents(chunks: string[], messageEnd?: string) {
  const { emit, onAgentEvent } = createAgentEventHarness();
  emitMessage(emit, "message_start");
  for (const chunk of chunks) {
    emitAssistantTextDelta(emit, chunk);
  }
  if (messageEnd !== undefined) {
    emitMessage(emit, "message_end", textAssistant(messageEnd));
  }
  return extractAgentEventPayloads(onAgentEvent.mock.calls);
}

it("preserves media directives when orphan close replacement has no text", () => {
  const last = hiddenTextEvents(
    ["private chain of thought </thi", "nk>\nMEDIA:/tmp/a.png\n"],
    "private chain of thought </think>\nMEDIA:/tmp/a.png\n",
  ).at(-1);
  expect(last).toMatchObject({ text: "", mediaUrls: ["/tmp/a.png"] });
  expect(last?.replace).toBeUndefined();
});

it("keeps close tag literals inside hidden fenced code stripped across deltas", () => {
  expect(hiddenTextEvents(["<think>\n```ts\nliteral ", "</think> still private"])).toEqual([]);
});

it.each([
  ["new-target", "Corrected", "text_end", undefined],
  [undefined, "Draft", "text_end", undefined],
  [undefined, "Corrected", "message_end", "First block."],
] as const)(
  "replaces pending reply directives with authoritative checkpoint target %j",
  async (replyToId, text, terminal, priorText) => {
    const { emit, subscription, onBlockReply } = blockReplyHarness({
      blockReplyBreak: terminal === "message_end" && !priorText ? "message_end" : "text_end",
      blockReplyChunking:
        terminal === "message_end"
          ? { minChars: 200, maxChars: 200, breakPreference: "sentence" }
          : undefined,
    });
    try {
      emitMessage(emit, "message_start");
      if (priorText) {
        for (const type of ["text_delta", "text_end"] as const) {
          emitResponsesText(emit, type, priorText, "prior-answer");
        }
        await subscription.waitForPendingEvents();
        expect(onBlockReply.mock.calls.map(([reply]) => reply.text)).toEqual([priorText]);
      }
      emitResponsesText(
        emit,
        "text_delta",
        "[[reply_to:old-target]] [[audio_as_voice]] Draft",
        "answer",
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
        emitMessage(emit, "message_end", message);
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
      }).toEqual({ text, replyToId, replyToTag: Boolean(replyToId), audioAsVoice: false });
    } finally {
      subscription.unsubscribe();
    }
  },
);

it("keeps unresolved mutating failure when an unrelated tool succeeds", async () => {
  const { emit, subscription, fail } = createToolErrorHarness("run-tools-1");
  fail("w1", "/tmp/demo.txt");
  expect(subscription.getLastToolError()?.toolName).toBe("write");
  runTool(emit, "read", "r1", { path: "/tmp/demo.txt" }, { text: "ok" });
  await subscription.waitForPendingEvents();
  expect(subscription.getLastToolError()?.toolName).toBe("write");
});

it("preserves distinct mutation failures through compaction until each action recovers", async () => {
  const { emit, subscription, fail, recover } = createToolErrorHarness("compaction-retry");
  fail("write-a-failed", "/tmp/a.txt");
  fail("write-b-failed", "/tmp/b.txt");
  emit(retryingCompactionEnd());
  recover("write-b-recovered", "/tmp/b.txt");
  await subscription.waitForPendingEvents();
  expect(subscription.getLastToolError()).toBeUndefined();
  recover("write-a-recovered", "/tmp/a.txt");
  await subscription.waitForPendingEvents();
  expect(subscription.getLastToolError()).toBeUndefined();
});

it("emits lifecycle:error event on agent_end when last assistant message was an error", () => {
  const { emit, onAgentEvent } = createAgentEventHarness({
    runId: "run-error",
    sessionKey: "test-session",
  });
  emitAssistantLifecycleErrorAndEnd({ emit, errorMessage: "429 Rate limit exceeded" });
  const lifecycleError = expectDefined(
    findLifecycleErrorAgentEvent(onAgentEvent.mock.calls),
    "Expected lifecycle error event",
  );
  const error = (lifecycleError.data as { error?: unknown } | undefined)?.error;
  expect(typeof error).toBe("string");
  expect(error).toContain("The AI service needs a short break");
});

it("reads terminal abort state before emitting lifecycle:end", () => {
  let terminalAborted = false;
  const { emit, onAgentEvent } = createAgentEventHarness({
    runId: "run-aborted",
    sessionKey: "test-session",
    isTerminalAborted: () => terminalAborted,
  });
  const assistantMessage = makeAgentAssistantMessage({
    stopReason: "aborted",
    content: [],
  });
  emitMessage(emit, "message_start", assistantMessage);
  emitMessage(emit, "message_end", assistantMessage);
  terminalAborted = true;
  emit({ type: "agent_end", messages: [assistantMessage] });
  const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
  expect(payloads).toContainEqual(
    expect.objectContaining({ phase: "end", stopReason: "aborted", aborted: true }),
  );
});

const childSpawn = {
  runId: "run-child",
  childSessionKey: "agent:claude:subagent:child",
  expectsCompletionMessage: true,
};
it.each([
  ["edit", { file_path: "/tmp/demo.txt", old_string: "before", new_string: "after" }, { ok: true }],
  ["cron", { action: "add", job: { name: "reminder" } }, { details: { status: "ok" } }],
  [
    "sessions_spawn",
    { prompt: "continue in a child session" },
    { details: { status: "accepted", ...childSpawn } },
  ],
] as const)(
  "preserves %s terminal evidence across compaction retries",
  async (toolName, args, result) => {
    const { emit, subscription, onAgentEvent } = createAgentEventHarness({
      runId: `run-${toolName}-compaction-evidence`,
      sessionKey: toolName === "cron" ? undefined : "test-session",
    });
    runTool(emit, toolName, "side-effect", args, result);
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
      expect(subscription.getAcceptedSessionSpawns()).toEqual([childSpawn]);
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
      expect.objectContaining({
        phase: "end",
        livenessState: toolName === "edit" ? "abandoned" : "working",
        replayInvalid: true,
      }),
    );
  },
);
