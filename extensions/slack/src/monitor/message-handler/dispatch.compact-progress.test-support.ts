import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { expect } from "vitest";

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

export function planUpdate(title: string) {
  return { type: "plan_update", title };
}

export function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
  extra?: Record<string, unknown>,
) {
  return { type: "task_update", id, title, status, ...extra };
}

export function contentTaskId(prefix: string) {
  return expect.stringMatching(new RegExp(`^${prefix}_[a-f0-9]{8}_1$`, "u"));
}

type Checkpoint = { kind: "checkpoint"; run: () => Promise<void> };
export function checkpoint(run: Checkpoint["run"]): Checkpoint {
  return { kind: "checkpoint", run };
}

type EventPayload<K extends keyof GetReplyOptions> =
  NonNullable<GetReplyOptions[K]> extends (payload: infer P) => unknown ? P : never;
type IdentityFields = "itemId" | "toolCallId" | "title" | "name" | "phase";
type Item = Pick<
  EventPayload<"onItemEvent">,
  IdentityFields | "status" | "summary" | "progressText" | "meta"
>;
type Tool = EventPayload<"onToolStart"> & { name: string };
type Patch = EventPayload<"onPatchSummary">;
type Command = Pick<EventPayload<"onCommandOutput">, IdentityFields | "status" | "exitCode"> & {
  explanation?: string;
};

export type SlackReplyOptionEvent =
  | (Item & { kind: "item"; itemKind?: string })
  | (Tool & { kind: "tool_start" })
  | (Patch & { kind: "patch" })
  | (Command & { kind: "command_output" })
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
  | Checkpoint
  | ({ kind: "approval" } & Parameters<NonNullable<GetReplyOptions["onApprovalEvent"]>>[0]);

/** A model preamble stays visible while successful and failed work continues. */
export async function emitCompactProgressScenario(reply: GetReplyOptions) {
  const plan = (steps: EventPayload<"onPlanUpdate">["steps"], explanation?: string) =>
    reply.onPlanUpdate?.({ phase: "update", steps, ...(explanation ? { explanation } : {}) });
  const preamble = (itemId: string, progressText: string) =>
    reply.onItemEvent?.({ kind: "preamble", itemId, phase: "end", progressText });
  const command = (itemId: string, exitCode: number) =>
    reply.onCommandOutput?.({ itemId, name: "bash", phase: "end", title: "pnpm test", exitCode });
  await plan([
    { step: "Inspect", status: "in_progress" },
    { step: "Patch", status: "pending" },
    { step: "Verify", status: "pending" },
  ]);
  await preamble("preamble-1", "Checking the current Slack behavior.");
  await reply.onToolStart?.({
    itemId: "tool-1",
    name: "bash",
    phase: "start",
    args: { command: "pnpm test" },
  });
  await command("tool-1", 0);
  await reply.onReasoningStream?.({ text: "Considering the transport choice." });
  await reply.onToolStart?.({
    toolCallId: "write-1",
    name: "write",
    phase: "start",
    args: { path: "result.txt", content: "fixed\n" },
  });
  await reply.onItemEvent?.({ toolCallId: "write-1", phase: "end", status: "completed" });
  await reply.onPatchSummary?.({
    phase: "end",
    title: "Apply patch",
    added: ["result.txt"],
    modified: [],
    deleted: [],
  });
  await plan([{ step: "Patch", status: "in_progress" }], "Running the checklist.");
  await preamble("preamble-2", "The fix is ready; I’m checking the result.");
  await command("tool-2", 1);
  await plan([{ step: "Verify", status: "completed" }], "Finishing the checklist.");
}
