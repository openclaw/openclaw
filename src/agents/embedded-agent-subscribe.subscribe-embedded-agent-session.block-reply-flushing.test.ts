import { describe, expect, it, vi } from "vitest";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

describe("block reply flush boundaries", () => {
  it("preserves indented code and trailing spaces when a tool flushes buffered text", async () => {
    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "indented-flush",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 200 },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "    literal  " });
    expect(onBlockReply).not.toHaveBeenCalled();
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "flush", args: {} });
    await subscription.waitForPendingEvents();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const ir = markdownToIR(onBlockReply.mock.calls[0]?.[0]?.text ?? "");
    expect(ir.styles.filter((span) => span.style === "code_block")).toEqual([
      { start: 0, end: "literal  \n".length, style: "code_block" },
    ]);
    expect(ir.text).toBe("literal  \n");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
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
});
