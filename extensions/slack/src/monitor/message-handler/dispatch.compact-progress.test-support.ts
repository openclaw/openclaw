import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";

export type SlackReplyOptionEvent =
  | {
      kind: "item";
      itemId?: string;
      toolCallId?: string;
      itemKind?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
      phase?: string;
      status?: string;
      meta?: string;
    }
  | {
      kind: "tool_start";
      itemId?: string;
      toolCallId?: string;
      name: string;
      phase?: string;
      args?: Record<string, unknown>;
      detailMode?: "explain" | "raw";
    }
  | {
      kind: "plan";
      phase?: string;
      explanation?: string;
      explanationFormat?: "plain";
      steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
    }
  | { kind: "concurrent_items"; progressTexts: string[] }
  | { kind: "partial"; text: string }
  | { kind: "assistant_start" }
  | { kind: "reasoning"; text?: string; isReasoningSnapshot?: boolean }
  | { kind: "reasoning_end" }
  | { kind: "checkpoint"; run: () => Promise<void> }
  | ({ kind: "approval" } & Parameters<NonNullable<GetReplyOptions["onApprovalEvent"]>>[0]);

export const FAILED_COMMAND_ITEM = {
  itemId: "tool-2",
  kind: "tool",
  name: "bash",
  phase: "end",
  meta: "pnpm test",
  status: "failed",
} as const;

/** A model preamble stays visible while successful and failed work continues. */
export async function emitCompactProgressScenario(reply: GetReplyOptions) {
  await reply.onPlanUpdate?.({
    phase: "update",
    steps: [
      { step: "Inspect", status: "in_progress" },
      { step: "Patch", status: "pending" },
      { step: "Verify", status: "pending" },
    ],
  });
  await reply.onItemEvent?.({
    kind: "preamble",
    itemId: "preamble-1",
    phase: "end",
    progressText: "Checking the current Slack behavior.",
  });
  await reply.onToolStart?.({
    itemId: "tool-1",
    name: "bash",
    phase: "start",
    args: { command: "pnpm test" },
  });
  await reply.onItemEvent?.({
    itemId: "tool-1",
    kind: "tool",
    name: "bash",
    phase: "end",
    meta: "pnpm test",
    status: "completed",
  });
  await reply.onReasoningStream?.({ text: "Considering the transport choice." });
  await reply.onToolStart?.({
    toolCallId: "write-1",
    name: "write",
    phase: "start",
    args: { path: "result.txt", content: "fixed\n" },
  });
  await reply.onItemEvent?.({
    toolCallId: "write-1",
    kind: "tool",
    phase: "end",
    status: "completed",
  });
  await reply.onItemEvent?.({
    itemId: "patch-1",
    toolCallId: "patch-1",
    kind: "patch",
    name: "apply_patch",
    phase: "end",
    status: "completed",
    title: "Apply patch",
    meta: "result.txt",
  });
  await reply.onPlanUpdate?.({
    phase: "update",
    explanation: "Running the checklist.",
    steps: [{ step: "Patch", status: "in_progress" }],
  });
  await reply.onItemEvent?.({
    kind: "preamble",
    itemId: "preamble-2",
    phase: "end",
    progressText: "The fix is ready; I’m checking the result.",
  });
  await reply.onItemEvent?.(FAILED_COMMAND_ITEM);
  await reply.onPlanUpdate?.({
    phase: "update",
    explanation: "Finishing the checklist.",
    steps: [{ step: "Verify", status: "completed" }],
  });
}
