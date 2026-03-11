import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantOutputSegments,
  reconcileAssistantOutputs,
  reconcileLiveAssistantCommentary,
} from "./assistant-output.js";

describe("assistant output extraction", () => {
  it("reads phase and signature ids from textSignature", () => {
    const message = {
      id: "msg-1",
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Step 1/3: checking status.",
          textSignature: JSON.stringify({ id: "sig-1", phase: "commentary" }),
        },
        {
          type: "text",
          text: " Final summary.",
          textSignature: JSON.stringify({ id: "sig-2", phase: "final_answer" }),
        },
      ],
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    const segments = extractAssistantOutputSegments(message as any);

    expect(segments).toEqual([
      {
        segmentId: "sig-1",
        text: "Step 1/3: checking status.",
        phase: "commentary",
      },
      {
        segmentId: "sig-2",
        text: "Final summary.",
        phase: "final_answer",
      },
    ]);
  });
});

describe("assistant output reconciliation", () => {
  it("delivers live commentary from a partial assistant stream message once", async () => {
    const onCommentary = vi.fn();
    const seenSegmentIds = new Set<string>();
    const message = {
      id: "assistant-1",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Step 1/3: checking status.",
          textSignature: JSON.stringify({ id: "sig-1", phase: "commentary" }),
        },
        {
          type: "text",
          text: " Final answer later.",
          textSignature: JSON.stringify({ id: "sig-2", phase: "final_answer" }),
        },
      ],
    };

    const firstPass = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: message as any,
      seenSegmentIds,
      onCommentary,
    });
    expect(firstPass.newOutputs).toEqual([
      {
        segmentId: "sig-1",
        text: "Step 1/3: checking status.",
        phase: "commentary",
      },
    ]);
    expect(onCommentary).toHaveBeenCalledTimes(1);

    const secondPass = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: message as any,
      seenSegmentIds,
      onCommentary,
    });
    expect(secondPass.newOutputs).toEqual([]);
    expect(onCommentary).toHaveBeenCalledTimes(1);
  });

  it("waits for a cumulative commentary segment to stop growing before delivering it", async () => {
    const onCommentary = vi.fn();
    const seenSegmentIds = new Set<string>();
    const firstPartial = {
      id: "assistant-stream",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Step 2/3:",
          textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
        },
      ],
    };
    const secondPartial = {
      ...firstPartial,
      content: [
        {
          type: "text",
          text: "Step 2/3: running lint.",
          textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
        },
      ],
    };
    const completedPartial = {
      ...firstPartial,
      content: [
        {
          type: "text",
          text: "Step 2/3: running lint.",
          textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    };

    const firstPass = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: firstPartial as any,
      seenSegmentIds,
      onCommentary,
    });
    expect(firstPass.newOutputs).toEqual([]);

    const secondPass = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: secondPartial as any,
      seenSegmentIds,
      onCommentary,
    });
    expect(secondPass.newOutputs).toEqual([]);

    const thirdPass = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: completedPartial as any,
      seenSegmentIds,
      onCommentary,
    });
    expect(thirdPass.newOutputs).toEqual([
      {
        segmentId: "sig-stream",
        text: "Step 2/3: running lint.",
        phase: "commentary",
      },
    ]);
    expect(onCommentary).toHaveBeenCalledTimes(1);
  });

  it("tracks finalized assistant outputs separately and revisits incomplete messages", async () => {
    const seenSegmentIds = new Set<string>();
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Step 1/3: checking status.",
            textSignature: JSON.stringify({ id: "sig-1", phase: "commentary" }),
          },
        ],
      },
    ];

    const firstPass = await reconcileAssistantOutputs({
      // oxlint-disable-next-line typescript/no-explicit-any
      messages: messages as any,
      startIndex: 0,
      seenSegmentIds,
    });
    expect(firstPass.newOutputs).toEqual([]);
    expect(firstPass.nextStartIndex).toBe(0);

    Object.assign(messages[0], { stopReason: "toolUse" });

    const secondPass = await reconcileAssistantOutputs({
      // oxlint-disable-next-line typescript/no-explicit-any
      messages: messages as any,
      startIndex: firstPass.nextStartIndex,
      seenSegmentIds,
    });
    expect(secondPass.newOutputs).toEqual([
      {
        segmentId: "sig-1",
        text: "Step 1/3: checking status.",
        phase: "commentary",
      },
    ]);
    expect(secondPass.nextStartIndex).toBe(1);
  });

  it("uses unique fallback ids for finalized assistant messages without ids or signatures", async () => {
    const seenSegmentIds = new Set<string>();
    const messages = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "text", text: "First assistant message." }],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Second assistant message." }],
      },
    ];

    const result = await reconcileAssistantOutputs({
      // oxlint-disable-next-line typescript/no-explicit-any
      messages: messages as any,
      startIndex: 0,
      seenSegmentIds,
    });

    expect(result.newOutputs).toHaveLength(2);
    expect(result.newOutputs[0]).toEqual(
      expect.objectContaining({
        text: "First assistant message.",
      }),
    );
    expect(result.newOutputs[1]).toEqual(
      expect.objectContaining({
        text: "Second assistant message.",
      }),
    );
    expect(result.newOutputs[0]?.segmentId).toMatch(/^assistant:stream-\d+:segment:0$/);
    expect(result.newOutputs[1]?.segmentId).toMatch(/^assistant:stream-\d+:segment:0$/);
    expect(result.newOutputs[0]?.segmentId).not.toBe(result.newOutputs[1]?.segmentId);
    expect(result.nextStartIndex).toBe(2);
  });

  it("stops finalized reconciliation at the first in-flight assistant message", async () => {
    const seenSegmentIds = new Set<string>();
    const messages = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "text", text: "Done before in-flight." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Still streaming." }],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Completed after in-flight." }],
      },
    ];

    const firstPass = await reconcileAssistantOutputs({
      // oxlint-disable-next-line typescript/no-explicit-any
      messages: messages as any,
      startIndex: 0,
      seenSegmentIds,
    });
    expect(firstPass.newOutputs).toHaveLength(1);
    expect(firstPass.newOutputs[0]).toEqual(
      expect.objectContaining({
        text: "Done before in-flight.",
      }),
    );
    expect(firstPass.newOutputs[0]?.segmentId).toMatch(/^assistant:stream-\d+:segment:0$/);
    expect(firstPass.nextStartIndex).toBe(1);

    Object.assign(messages[1], { stopReason: "toolUse" });
    const secondPass = await reconcileAssistantOutputs({
      // oxlint-disable-next-line typescript/no-explicit-any
      messages: messages as any,
      startIndex: firstPass.nextStartIndex,
      seenSegmentIds,
    });

    expect(secondPass.newOutputs).toHaveLength(2);
    expect(secondPass.newOutputs[0]).toEqual(
      expect.objectContaining({
        text: "Still streaming.",
      }),
    );
    expect(secondPass.newOutputs[1]).toEqual(
      expect.objectContaining({
        text: "Completed after in-flight.",
      }),
    );
    expect(secondPass.newOutputs[0]?.segmentId).toMatch(/^assistant:stream-\d+:segment:0$/);
    expect(secondPass.newOutputs[1]?.segmentId).toMatch(/^assistant:stream-\d+:segment:0$/);
    expect(secondPass.newOutputs[0]?.segmentId).not.toBe(secondPass.newOutputs[1]?.segmentId);
    expect(secondPass.nextStartIndex).toBe(3);
  });

  it("rewinds stale reconcile cursor when message history compacts", async () => {
    const seenSegmentIds = new Set<string>();
    const messages = [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Final output after compaction." }],
      },
    ];

    const result = await reconcileAssistantOutputs({
      // oxlint-disable-next-line typescript/no-explicit-any
      messages: messages as any,
      startIndex: 5,
      seenSegmentIds,
    });

    expect(result.newOutputs).toHaveLength(1);
    expect(result.newOutputs[0]).toEqual(
      expect.objectContaining({
        text: "Final output after compaction.",
      }),
    );
    expect(result.newOutputs[0]?.segmentId).toMatch(/^assistant:stream-\d+:segment:0$/);
    expect(result.nextStartIndex).toBe(1);
  });

  it("falls back to assistant message id and segment ordinal when no signature id exists", async () => {
    const onCommentary = vi.fn();
    const seenSegmentIds = new Set<string>();
    const message = {
      id: "assistant-2",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Step 1/3: checking status.",
          phase: "commentary",
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    };

    const result = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: message as any,
      seenSegmentIds,
      onCommentary,
    });

    expect(result.newOutputs).toEqual([
      {
        segmentId: "assistant:assistant-2:segment:0",
        text: "Step 1/3: checking status.",
        phase: "commentary",
      },
    ]);
    expect(onCommentary).toHaveBeenCalledTimes(1);
  });

  it("uses distinct live fallback ids for commentary messages without ids or signatures", async () => {
    const onCommentary = vi.fn();
    const seenSegmentIds = new Set<string>();
    const firstMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "First live commentary.",
          phase: "commentary",
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    };
    const secondMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Second live commentary.",
          phase: "commentary",
        },
        {
          type: "toolCall",
          toolCallId: "call-2",
          toolName: "exec",
          args: "{}",
        },
      ],
    };

    const firstResult = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: firstMessage as any,
      seenSegmentIds,
      onCommentary,
    });
    const secondResult = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: secondMessage as any,
      seenSegmentIds,
      onCommentary,
    });

    expect(firstResult.newOutputs).toHaveLength(1);
    expect(secondResult.newOutputs).toHaveLength(1);
    expect(firstResult.newOutputs[0]?.segmentId).not.toEqual(secondResult.newOutputs[0]?.segmentId);
    expect(firstResult.newOutputs[0]?.segmentId).toMatch(/^assistant:stream-\d+:segment:0$/);
    expect(secondResult.newOutputs[0]?.segmentId).toMatch(/^assistant:stream-\d+:segment:0$/);
    expect(onCommentary).toHaveBeenCalledTimes(2);
  });

  it("reuses fallback segment ids between live and finalized reconciliation", async () => {
    const onCommentary = vi.fn();
    const seenSegmentIds = new Set<string>();
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Live commentary without ids.",
          phase: "commentary",
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    };

    const liveResult = await reconcileLiveAssistantCommentary({
      // oxlint-disable-next-line typescript/no-explicit-any
      message: message as any,
      seenSegmentIds,
      onCommentary,
    });
    expect(liveResult.newOutputs).toHaveLength(1);

    Object.assign(message, { stopReason: "toolUse" });
    const finalizedResult = await reconcileAssistantOutputs({
      // oxlint-disable-next-line typescript/no-explicit-any
      messages: [message] as any,
      startIndex: 0,
      seenSegmentIds,
    });

    expect(finalizedResult.newOutputs).toEqual([]);
    expect(finalizedResult.nextStartIndex).toBe(1);
  });
});
