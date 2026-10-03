import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";

const requireRecord = createRequireRecord("object", "label-not-object");
const noopAsync = async () => {};

export function createDraftStreamStub() {
  return {
    update: vi.fn(),
    flush: vi.fn(noopAsync),
    clear: vi.fn(noopAsync),
    discardPending: vi.fn(noopAsync),
    seal: vi.fn(noopAsync),
    stop: vi.fn(() => {}),
    forceNewMessage: vi.fn(),
    dropDetachedMessages: vi.fn(noopAsync),
    finalizeMessage: vi.fn(async (_messageId: string, editFinal: () => Promise<void>) => {
      await editFinal();
      return true;
    }),
    messageId: (): string | undefined => "171234.567",
    channelId: () => "C123",
  };
}

export function draftUpdateTexts(draftStream: ReturnType<typeof createDraftStreamStub>): string[] {
  return draftStream.update.mock.calls.map(([update]) => {
    if (typeof update === "string") {
      return update;
    }
    return requireRecord(update, "draft update").text as string;
  });
}

export function expectLastDraftUpdateText(
  draftStream: ReturnType<typeof createDraftStreamStub>,
  expected: string,
) {
  expect(draftUpdateTexts(draftStream).at(-1)).toBe(expected);
}

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
      kind: "patch";
      itemId?: string;
      toolCallId?: string;
      phase?: string;
      title?: string;
      name?: string;
      added?: string[];
      modified?: string[];
      deleted?: string[];
      summary?: string;
    }
  | {
      kind: "command_output";
      itemId?: string;
      toolCallId?: string;
      phase?: string;
      title?: string;
      name?: string;
      explanation?: string;
      status?: string;
      exitCode?: number | null;
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
  await reply.onCommandOutput?.({
    itemId: "tool-1",
    name: "bash",
    phase: "end",
    title: "pnpm test",
    exitCode: 0,
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
    phase: "end",
    status: "completed",
  });
  await reply.onPatchSummary?.({
    phase: "end",
    title: "Apply patch",
    added: ["result.txt"],
    modified: [],
    deleted: [],
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
  await reply.onCommandOutput?.({
    itemId: "tool-2",
    name: "bash",
    phase: "end",
    title: "pnpm test",
    exitCode: 1,
  });
  await reply.onPlanUpdate?.({
    phase: "update",
    explanation: "Finishing the checklist.",
    steps: [{ step: "Verify", status: "completed" }],
  });
}
