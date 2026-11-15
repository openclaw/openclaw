import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { expect, vi } from "vitest";
import { requireRecord } from "./dispatch.preview.test-support.js";

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
  | { kind: "visible_work"; sessions: EventPayload<"onVisibleWorkSessions"> }
  | Checkpoint
  | ({ kind: "approval" } & Parameters<NonNullable<GetReplyOptions["onApprovalEvent"]>>[0]);

export async function emitSlackToolProgressTestEvent(
  reply: GetReplyOptions | undefined,
  entry: Extract<SlackReplyOptionEvent, { kind: "command_output" | "tool_start" }>,
  index: number,
) {
  if (entry.kind === "command_output") {
    const { kind: _kind, explanation: _explanation, ...payload } = entry;
    await reply?.onCommandOutput?.(payload);
    if (entry.phase === "end") {
      const item = projectAgentToolActivity({
        toolCallId: entry.toolCallId ?? entry.itemId ?? `tool-${index}`,
        name: entry.name ?? "exec",
        phase: "result",
        isError: entry.exitCode == null ? undefined : entry.exitCode !== 0,
        meta: entry.title,
      });
      await reply?.onItemEvent?.({ ...item, itemId: entry.itemId ?? item.itemId });
    }
    return;
  }
  const { kind: _kind, ...payload } = entry;
  await reply?.onToolStart?.(payload);
  const item = projectAgentToolActivity({
    toolCallId: entry.toolCallId ?? entry.itemId ?? `tool-${index}`,
    name: entry.name,
    phase: entry.phase === "update" ? "update" : "start",
    args: entry.args,
  });
  await reply?.onItemEvent?.({ ...item, itemId: entry.itemId ?? item.itemId });
}

/** A model preamble stays visible while successful and failed work continues. */
export async function emitCompactProgressScenario(reply: GetReplyOptions) {
  const plan = (steps: EventPayload<"onPlanUpdate">["steps"], explanation?: string) =>
    reply.onPlanUpdate?.({ phase: "update", steps, ...(explanation ? { explanation } : {}) });
  const emitPreamble = (itemId: string, progressText: string) =>
    reply.onItemEvent?.({ kind: "preamble", itemId, phase: "end", progressText });
  const command = (itemId: string, exitCode: number) =>
    reply.onCommandOutput?.({ itemId, name: "bash", phase: "end", title: "pnpm test", exitCode });
  await plan([
    { step: "Inspect", status: "in_progress" },
    { step: "Patch", status: "pending" },
    { step: "Verify", status: "pending" },
  ]);
  await emitPreamble("preamble-1", "Checking the current Slack behavior.");
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
  await emitPreamble("preamble-2", "The fix is ready; I’m checking the result.");
  await command("tool-2", 1);
  await plan([{ step: "Verify", status: "completed" }], "Finishing the checklist.");
}

export type TestReplyDispatchKind = "tool" | "block" | "final";
export type TestReplyPayload = {
  text?: string;
  replyToId?: string;
  replyToCurrent?: boolean;
  isError?: boolean;
  isReasoning?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  spokenText?: string;
  ttsSupplement?: { spokenText: string; visibleTextAlreadyDelivered?: boolean };
  presentation?: { blocks: unknown[] };
};
export type TestDispatchCounts = Record<TestReplyDispatchKind, number>;
export type TestDispatchSequenceEntry =
  | {
      kind: TestReplyDispatchKind;
      payload: TestReplyPayload;
    }
  | { kind: "queued_followup" }
  | { kind: "item"; progressText: string }
  | { kind: "checkpoint"; run: () => Promise<void> };

export function preamble(
  progressText: string,
  itemId: string,
  phase?: string,
): Extract<SlackReplyOptionEvent, { kind: "item" }> {
  return { kind: "item", itemKind: "preamble", progressText, itemId, phase };
}

export function approval(
  command: string,
  approvalId = "approval-1",
): Extract<SlackReplyOptionEvent, { kind: "approval" }> {
  return { kind: "approval", phase: "requested", approvalId, command };
}

export function toolStart(
  args?: Record<string, unknown>,
  identity: { itemId?: string; toolCallId?: string } = {},
): Extract<SlackReplyOptionEvent, { kind: "tool_start" }> {
  return {
    kind: "tool_start",
    name: "bash",
    phase: "start",
    ...identity,
    ...(args ? { args } : {}),
  };
}

export function finalReply(payload: TestReplyPayload): TestDispatchSequenceEntry {
  return { kind: "final", payload };
}

export function presentation(text: string, blocks: unknown[]) {
  return { text, presentation: { blocks } };
}

export function planEvent(
  step: string,
  explanation?: string,
): Extract<SlackReplyOptionEvent, { kind: "plan" }> {
  return {
    kind: "plan",
    phase: "update",
    ...(explanation === undefined ? {} : { explanation }),
    steps: [{ step, status: "in_progress" }],
  };
}

export function textReply(
  text: string,
  kind: TestReplyDispatchKind = "final",
): TestDispatchSequenceEntry {
  return { kind, payload: { text } };
}

export function section(text: string, plain = false) {
  return {
    type: "section",
    text: { type: plain ? "plain_text" : "mrkdwn", text, ...(plain ? { emoji: false } : {}) },
  };
}

export function workSession(id: number, label?: string) {
  return {
    sessionKey: `agent:agent-1:dashboard:work-${id}`,
    url: `https://team.openclaw.ai/openclaw/chat/agent-1/work-${id}`,
    ...(label ? { label } : {}),
  };
}

export function ttsPayload(spokenText = "Spoken answer", visibleTextAlreadyDelivered?: boolean) {
  return {
    mediaUrl: "https://example.com/tts.mp3",
    audioAsVoice: true,
    spokenText,
    ttsSupplement: {
      spokenText,
      ...(visibleTextAlreadyDelivered ? { visibleTextAlreadyDelivered: true } : {}),
    },
  };
}

export function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export function expectCalls(count: number, ...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

const noop = () => {};
export const noopAsync = async () => {};
export function createDraftStreamStub() {
  return {
    update: vi.fn(),
    flush: vi.fn(noopAsync),
    clear: vi.fn(noopAsync),
    discardPending: vi.fn(noopAsync),
    seal: vi.fn(noopAsync),
    stop: vi.fn(noop),
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

export function nativeChunks(calls: readonly (readonly unknown[])[]) {
  return calls.flatMap(([input]) => {
    const chunks = requireRecord(input, "native stream input").chunks;
    return Array.isArray(chunks) ? chunks.map((chunk) => requireRecord(chunk, "native chunk")) : [];
  });
}
