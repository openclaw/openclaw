import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import * as agentEvents from "../infra/agent-events.js";
import { createDeliveryHarness } from "./embedded-agent-subscribe.delivery.test-support.js";
import {
  createSubscribedSessionHarness,
  emitMessageStartAndEndForAssistantText,
  emitToolRun,
  extractAgentEventPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";
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
  return createDeliveryHarness({ blockReplyBreak: undefined, ...options });
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

it.each([
  { name: "graphemes", source: `${"x".repeat(1195)}👨‍👩‍👧‍👦done`, minChars: 800, maxChars: 1200 },
  { name: "empty tool payloads", source: "[tool:read] {}\n[tool:read] {}\n", hidden: true },
  {
    name: "write payloads",
    source:
      '[tool:write]\n{"path":"notes.txt","content":"SECRET CONTENT"}\n[tool:read]\n{"path":"b"}\n',
    hidden: true,
  },
  {
    name: "literal inline code",
    source:
      '`\n[tool:write]\n{"content":"a` This literal example stays visible and keeps streaming as ordinary block replies without any structural terminator.',
    minChars: 64,
    maxChars: 128,
    visible: ["ordinary block replies"],
    // Markdown ownership can still change, so only settled or terminal delivery is promised.
  },
  {
    name: "next message after an unfinished hold",
    source: "Hello there, this is visible prose without newlines",
    prefix: "[a]\n{",
    visible: ["Hello there"],
    beforeEnd: "Hello there",
  },
])("streams $name at the block-delivery boundary", async (test) => {
  const { minChars = 8, maxChars = 24 } = test;
  const { emit, subscription, onBlockReply } = blockReplyHarness({
    blockReplyBreak: "text_end",
    blockReplyChunking: { minChars, maxChars, breakPreference: "paragraph" },
  });
  if (test.prefix) {
    emitMessage(emit, "message_start");
    emitResponsesText(emit, "text_delta", test.prefix, "prior");
    emitResponsesText(emit, "text_end", test.prefix, "prior");
    emitMessage(emit, "message_end", textAssistant(test.prefix));
    await subscription.waitForPendingEvents();
    onBlockReply.mockClear();
  }
  emitMessage(emit, "message_start");
  let text = "";
  for (const delta of Array.from(test.source)) {
    text += delta;
    emitResponsesText(emit, "text_delta", text, "answer", delta);
  }
  const chunks = () => onBlockReply.mock.calls.map(([reply]) => reply.text ?? "");
  await subscription.waitForPendingEvents();
  if (test.beforeEnd) {
    expect(chunks().join("").replace(/\s/gu, "")).toContain(test.beforeEnd.replace(/\s/gu, ""));
  }
  emitResponsesText(emit, "text_end", test.source, "answer");
  emit({ type: "agent_end", messages: [], willRetry: false });
  await subscription.waitForPendingEvents();
  if (test.hidden) {
    expect(chunks()).toEqual([]);
  }
  const source = onBlockReply.mock.calls
    .map(([reply]) => getReplyPayloadMetadata(reply)?.blockSourceText ?? reply.text ?? "")
    .join("");
  expect(source.trimEnd()).toBe(test.hidden ? "" : test.source);
  for (const visible of test.visible ?? []) {
    expect(chunks().join("").replace(/\s/gu, "")).toContain(visible.replace(/\s/gu, ""));
  }
  if (test.name === "graphemes") {
    expect(chunks().length).toBeGreaterThan(1);
    expect(chunks().join("")).toBe(test.source);
    expect(chunks().filter((chunk) => chunk.includes("👨‍👩‍👧‍👦"))).toHaveLength(1);
    expect(chunks().every((chunk) => chunk.length <= maxChars)).toBe(true);
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
  const earlyMediaPayloads = onBlockReply.mock.calls.filter(
    ([payload]) => payload.mediaUrls?.length,
  );
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
  const mediaPayloads = onBlockReply.mock.calls.filter(([payload]) =>
    payload.mediaUrls?.includes("/tmp/generated.png"),
  );
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
  emitMessageStartAndEndForAssistantText({ emit, text: "Done." });
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
  emitUpdate(emit, thinkingMessage("Checking files"), {
    type: "thinking_delta",
    delta: "Checking files",
  });
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
  emitUpdate(emit, thinkingMessage("Checking"), { type: "thinking_end" });
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

const SENTINEL = "SECRET CONTENT";
const call = `[tool:block_reply_proof]\n{"path":"notes.txt","content":"${SENTINEL}"}\n`;
const ordinaryProse =
  "First sentence stays visible. Second sentence stays visible. Third sentence stays visible.";
const documents = {
  "late image reference":
    "![example `x\n<tool_call><function=read>{}</function></tool_call>\nx`][id]\n\n[id]: /url\n",
  "late link title":
    '[label](/url "title\n`x\n<tool_call><function=read>{}</function></tool_call>\nx` trailing\n")\n',
  "late table delimiter":
    "| Example | `x\n<tool_call><function=read>{}</function></tool_call>\nx` |\n| --- | --- |\n",
  "two-space fence": '  Example\n  ```text\n  [tool:read] {"path":"x"}\n  ```\n  Tail.',
  "four-space code": "    <tool_call><function=read>{}</function></tool_call>",
  "argument payload": call,
  "prose around a call": `Intro paragraph stays visible.\n${call}Tail paragraph stays visible.`,
  "ordinary prose": ordinaryProse,
  "less-than literal": "The expression a < b && c > d remains ordinary prose.",
  "partial tool literal": "Ordinary prose mentions <tool_ as a literal token.",
  "inline XML example": "Use `<tool_call><function=read>{}</function></tool_call>` as an example.",
  "fenced XML example":
    "Example:\n```xml\n<tool_call><function=read>{}</function></tool_call>\n```\nTail.",
  "fenced call example": 'Example:\n```text\n[tool:read] {"path":"x"}\n```\nTail.',
  "multiline inline code":
    '`\n[tool:write]\n{"content":"literal"` followed by ordinary visible text.',
  "unfinished header": "[tool:block_reply_proof",
  "unfinished payload": '[tool:block_reply_proof]\n{"content":"unfinished',
} as const;

function chunkings(text: string): string[][] {
  return [
    ...Array.from({ length: text.length + 1 }, (_, at) => [text.slice(0, at), text.slice(at)]),
    ...[1, 4].map((size) =>
      Array.from({ length: Math.ceil(text.length / size) }, (_, at) =>
        text.slice(at * size, (at + 1) * size),
      ),
    ),
  ];
}

async function streamReply(params: {
  chunks: readonly string[];
  emit: (evt: unknown) => void;
  beforeEnd?: () => Promise<void>;
}) {
  emitMessage(params.emit, "message_start");
  const projection = createAssistantVisibleStreamText("final_answer");
  let prefix = "";
  for (const delta of params.chunks) {
    prefix += delta;
    emitResponsesText(params.emit, "text_delta", prefix, "canonical-answer", delta);
    expect(projection.append(delta).text, JSON.stringify(prefix)).toBe(
      sanitizeAssistantVisibleStreamText(prefix, "final_answer"),
    );
  }
  await params.beforeEnd?.();
  emitResponsesText(params.emit, "text_end", prefix, "canonical-answer");
  emitMessage(params.emit, "message_end", { ...textAssistant(prefix), phase: "final_answer" });
}

it.each(Object.entries(documents))(
  "preserves canonical delivered bytes across every split: %s",
  async (_name, doc) => {
    const expected = sanitizeAssistantVisibleStreamText(doc, "final_answer");
    expect(expected).not.toContain(SENTINEL);
    for (const chunks of chunkings(doc)) {
      const blocks: string[] = [];
      const sources: string[] = [];
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "block-parity",
        onBlockReply: (payload) => {
          blocks.push(payload.text ?? "");
          sources.push(getReplyPayloadMetadata(payload)?.blockSourceText ?? payload.text ?? "");
        },
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 12, maxChars: 40 },
      });
      try {
        await streamReply({
          chunks,
          emit,
          beforeEnd: async () => {
            await subscription.waitForPendingEvents();
            if (_name === "ordinary prose") {
              expect(blocks.length).toBeGreaterThan(1);
            }
            if (_name.startsWith("unfinished") || _name === "multiline inline code") {
              expect(blocks).toEqual([]);
            }
          },
        });
        await subscription.waitForPendingEvents();
        // Source metadata excludes the chunker's synthetic close/reopen fences and retains
        // separators consumed at message boundaries, so compare original visible bytes.
        if (_name === "prose around a call") {
          // Separate channel messages own their boundary whitespace.
          expect(blocks.map((text) => text.trim())).toEqual(expected.split("\n"));
        } else {
          expect(sources.join("").trimEnd(), JSON.stringify({ chunks, blocks, sources })).toBe(
            expected,
          );
        }
        if (!expected) {
          expect(blocks).toEqual([]);
        }
        if (_name === "unfinished payload") {
          // A held candidate must not delay the next assistant message.
          blocks.length = 0;
          await streamReply({
            chunks: [ordinaryProse],
            emit,
            beforeEnd: async () => {
              await subscription.waitForPendingEvents();
              expect(blocks.length).toBeGreaterThan(0);
            },
          });
          await subscription.waitForPendingEvents();
        }
      } finally {
        subscription.unsubscribe();
      }
    }
  },
);
