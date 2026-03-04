import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

/**
 * Regression tests for #34661: channel delivery must include ALL assistant text
 * segments across tool call boundaries, not just the last one.
 */
describe("subscribeEmbeddedPiSession – channel delivery full text across tool calls", () => {
  function emitToolRun(params: {
    emit: (evt: unknown) => void;
    toolName: string;
    toolCallId: string;
    args?: Record<string, unknown>;
    isError: boolean;
    result: unknown;
  }): void {
    params.emit({
      type: "tool_execution_start",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      args: params.args,
    });
    params.emit({
      type: "tool_execution_end",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      isError: params.isError,
      result: params.result,
    });
  }

  function emitFullAssistantMessage(params: { emit: (evt: unknown) => void; text: string }): void {
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: params.text }],
    } as AssistantMessage;
    params.emit({ type: "message_start", message: assistantMessage });
    emitAssistantTextDelta({ emit: params.emit, delta: params.text });
    emitAssistantTextEnd({ emit: params.emit });
    params.emit({ type: "message_end", message: assistantMessage });
  }

  it("accumulates all text segments without onBlockReply (no chunker)", () => {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
    });

    emitFullAssistantMessage({ emit, text: "Pre-tool text" });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "t1",
      args: { path: "/tmp/test.txt" },
      isError: false,
      result: { content: "file contents" },
    });

    emitFullAssistantMessage({ emit, text: "Post-tool text" });

    expect(subscription.assistantTexts).toEqual(["Pre-tool text", "Post-tool text"]);
  });

  it("accumulates all text segments with blockReplyChunking but without onBlockReply", () => {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
    });

    emitFullAssistantMessage({ emit, text: "Pre-tool text" });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "t1",
      args: { path: "/tmp/test.txt" },
      isError: false,
      result: { content: "file contents" },
    });

    emitFullAssistantMessage({ emit, text: "Post-tool text" });

    expect(subscription.assistantTexts).toEqual(["Pre-tool text", "Post-tool text"]);
  });

  it("accumulates all text segments with onBlockReply and text_end break", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: {
        minChars: 50,
        maxChars: 200,
        breakPreference: "paragraph",
      },
    });

    emitFullAssistantMessage({ emit, text: "Pre-tool text" });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "t1",
      args: { path: "/tmp/test.txt" },
      isError: false,
      result: { content: "file contents" },
    });

    emitFullAssistantMessage({ emit, text: "Post-tool text" });

    expect(subscription.assistantTexts).toEqual(["Pre-tool text", "Post-tool text"]);
  });

  it("handles three segments with two interleaved tool calls", () => {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
    });

    emitFullAssistantMessage({ emit, text: "Segment 1" });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "t1",
      args: { path: "/a.txt" },
      isError: false,
      result: { content: "data" },
    });

    emitFullAssistantMessage({ emit, text: "Segment 2" });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "t2",
      args: { path: "/b.txt" },
      isError: false,
      result: { content: "data" },
    });

    emitFullAssistantMessage({ emit, text: "Segment 3" });

    expect(subscription.assistantTexts).toEqual(["Segment 1", "Segment 2", "Segment 3"]);
  });
});
