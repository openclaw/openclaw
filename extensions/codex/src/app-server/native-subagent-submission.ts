import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  codexNativeSubagentHistoryOwnerSchema,
  matchesCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";

const identifier = z.string().refine((value) => Boolean(value.trim()));
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
  assertCurrent(): void;
  read(): readonly CodexNativeSubagentSubmission[];
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
  const owner = codexNativeSubagentHistoryOwnerSchema.parse(params.owner);
  const receipt = submissionSchema.parse(params.receipt);
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
  if (params.consume) {
    if (!current) {
      return { applied: false };
    }
    const remaining = receipts.filter((entry) => entry !== existing);
    return {
      applied: true,
      ...(remaining.length
        ? { next: { version: 1, owner: current.owner, receipts: remaining } }
        : {}),
    };
  }
  return {
    applied: true,
    next: {
      version: 1,
      owner: current?.owner ?? owner,
      receipts: existing ? receipts : [...receipts, receipt],
    },
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
