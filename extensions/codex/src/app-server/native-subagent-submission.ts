import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  codexNativeSubagentHistoryOwnerSchema,
  matchesCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";

const identifier = z.string().refine((value) => Boolean(value.trim()));
export const CODEX_NATIVE_SUBAGENT_SUBMISSION_HOOK_TOOL = "multi_agent_v1send_input";
const nativeSubmissionHookSchema = z.object({
  agent_id: identifier.optional(),
  turn_id: identifier,
  hook_event_name: z.literal("PostToolUse"),
  tool_name: z.literal(CODEX_NATIVE_SUBAGENT_SUBMISSION_HOOK_TOOL),
  tool_use_id: identifier,
  tool_input: z.object({ target: identifier }),
  tool_response: z.string(),
});
const nativeSubmissionResultSchema = z.object({ submission_id: identifier });

function canonicalizeNativeThreadId(value: string): string {
  // Successful send_input accepts UUID aliases but collaboration items serialize canonical IDs.
  const hex = value
    .replace(/^urn:uuid:/i, "")
    .replace(/^\{(.*)\}$/, "$1")
    .replaceAll("-", "")
    .toLowerCase();
  return hex.replace(
    /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
    "$1-$2-$3-$4-$5",
  );
}

export type CodexNativeSubagentSubmissionAcknowledgement = {
  senderThreadId?: string;
  parentTurnId: string;
  callId: string;
  childThreadId: string;
  submissionId: string;
};

/** Successful native results retain their nested call identity before Code Mode wraps them. */
export function readCodexNativeSubagentSubmissionAcknowledgement(
  rawPayload: unknown,
): CodexNativeSubagentSubmissionAcknowledgement {
  const payload = nativeSubmissionHookSchema.parse(rawPayload);
  const result = nativeSubmissionResultSchema.parse(JSON.parse(payload.tool_response));
  return {
    senderThreadId: payload.agent_id,
    parentTurnId: payload.turn_id,
    callId: payload.tool_use_id,
    childThreadId: canonicalizeNativeThreadId(payload.tool_input.target),
    submissionId: result.submission_id,
  };
}

export const submissionSchema = z
  .object({
    parentTurnId: identifier,
    callId: identifier,
    childThreadId: identifier,
    submissionId: identifier,
    predecessorRunId: identifier,
    predecessorNativeTurnId: identifier,
  })
  .strict();
const submissionsSchema = z
  .object({
    version: z.literal(1),
    owner: codexNativeSubagentHistoryOwnerSchema,
    receipts: z.array(submissionSchema),
  })
  .strict()
  .refine(
    ({ receipts }) =>
      new Set(receipts.map(({ parentTurnId, callId }) => JSON.stringify([parentTurnId, callId])))
        .size === receipts.length,
  );

export type CodexNativeSubagentSubmission = z.infer<typeof submissionSchema>;
export type CodexNativeSubagentSubmissions = z.infer<typeof submissionsSchema>;

export type CodexNativeSubagentSubmissionStore = {
  /** Retained source facts belong to the monitor until detached work settles. */
  release?: () => void;
  /** In-process binding ownership; use the async check before recovered work escapes. */
  assertCurrent(): void;
  assertCurrentAsync(): Promise<void>;
  read(): Promise<readonly CodexNativeSubagentSubmission[]>;
  record(receipt: CodexNativeSubagentSubmission, assertCurrent: () => void): Promise<boolean>;
  consume(receipt: CodexNativeSubagentSubmission, assertCurrent: () => void): Promise<boolean>;
};

export function matchesCodexNativeSubagentSubmissionOwner(
  stored: CodexNativeSubagentHistoryOwner,
  current: CodexNativeSubagentHistoryOwner,
): boolean {
  return (
    stored.parentThreadId === current.parentThreadId &&
    matchesCodexNativeSubagentHistoryOwner(stored, current)
  );
}

export function readCodexNativeSubagentSubmissions(
  value: unknown,
): CodexNativeSubagentSubmissions | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = submissionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid Codex native subagent submission metadata.");
  }
  return parsed.data;
}

export function mutateCodexNativeSubagentSubmissions(params: {
  current: unknown;
  owner: CodexNativeSubagentHistoryOwner;
  receipt: CodexNativeSubagentSubmission;
  consume: boolean;
}): { applied: boolean; next?: CodexNativeSubagentSubmissions } {
  const current = readCodexNativeSubagentSubmissions(params.current);
  const { owner, receipt } = params;
  if (current && !matchesCodexNativeSubagentSubmissionOwner(current.owner, owner)) {
    return { applied: false };
  }
  const receipts = current?.receipts ?? [];
  const existing = receipts.find(
    (entry) => entry.parentTurnId === receipt.parentTurnId && entry.callId === receipt.callId,
  );
  if (existing && !isDeepStrictEqual(existing, receipt)) {
    return { applied: false };
  }
  if (params.consume && !current) {
    return { applied: false };
  }
  const nextReceipts = params.consume
    ? receipts.filter((entry) => entry !== existing)
    : existing
      ? receipts
      : [...receipts, receipt];
  return {
    applied: true,
    ...(nextReceipts.length
      ? { next: { version: 1, owner: current?.owner ?? owner, receipts: nextReceipts } }
      : {}),
  };
}

/** Physical adoption cannot establish continuity for an unstamped receipt. */
export function adoptCodexNativeSubagentSubmissions(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const parsed = submissionsSchema.safeParse(value);
  return !parsed.success || parsed.data.owner.lifecycleRevision ? value : undefined;
}
