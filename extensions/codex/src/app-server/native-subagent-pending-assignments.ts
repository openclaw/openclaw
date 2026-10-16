import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  codexNativeSubagentRunId,
  readCodexNativeSubagentRunId,
} from "./native-subagent-assignment.js";
import {
  codexNativeSubagentHistoryOwnerSchema,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import { submissionSchema } from "./native-subagent-submission.js";

const identifier = z.string().trim().min(1);
const assignmentSchema = z
  .object({
    runId: identifier,
    childThreadId: identifier,
    nativeTurnId: identifier.optional(),
    nativeParentThreadId: identifier,
    owner: codexNativeSubagentHistoryOwnerSchema,
    // Accepted but not yet observed follow-ups keep their actual strict receipt.
    submission: submissionSchema.optional(),
    recordedCompletion: z
      .object({
        childThreadId: identifier,
        status: z.enum(["succeeded", "failed", "cancelled"]),
        statusLabel: z.literal("recorded_task_result"),
        result: z.string().min(1),
        completedAt: z.number().finite().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (entry) =>
      !entry.recordedCompletion || entry.recordedCompletion.childThreadId === entry.childThreadId,
  )
  .refine(
    (entry) =>
      !entry.submission ||
      (entry.submission.childThreadId === entry.childThreadId &&
        entry.nativeTurnId === entry.submission.submissionId &&
        entry.runId ===
          codexNativeSubagentRunId(entry.childThreadId, entry.submission.submissionId)),
  )
  .refine(
    (entry) =>
      entry.runId === codexNativeSubagentRunId(entry.childThreadId) ||
      (entry.nativeTurnId !== undefined &&
        readCodexNativeSubagentRunId(entry.runId)?.threadId === entry.childThreadId),
  );
const inventorySchema = z
  .object({
    version: z.literal(1),
    assignments: z.array(assignmentSchema),
  })
  .strict();

export type CodexNativeSubagentPendingAssignment = z.infer<typeof assignmentSchema>;
export type CodexNativeSubagentAssignmentStore = {
  /** In-process binding ownership; use the async check before recovered work escapes. */
  assertCurrent(): void;
  assertCurrentAsync(): Promise<void>;
  read(): Promise<readonly CodexNativeSubagentPendingAssignment[]>;
  record(
    assignment: CodexNativeSubagentPendingAssignment,
    assertCurrent: () => void,
  ): Promise<boolean>;
  consume(
    assignment: CodexNativeSubagentPendingAssignment,
    assertCurrent: () => void,
    undelivered?: { status: "succeeded" | "failed" | "cancelled" },
  ): Promise<boolean>;
};

/** Native parent rotation is not physical requester or connection adoption. */
export function matchesNativeAssignmentLifecycle(
  saved: CodexNativeSubagentHistoryOwner,
  current: CodexNativeSubagentHistoryOwner,
): boolean {
  return (
    saved.sessionId === current.sessionId &&
    saved.lifecycleRevision === current.lifecycleRevision &&
    saved.connectionFingerprint === current.connectionFingerprint
  );
}

export function readNativePendingAssignments(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = inventorySchema.safeParse(value);
  if (
    !parsed.success ||
    new Set(parsed.data.assignments.map((entry) => entry.runId)).size !==
      parsed.data.assignments.length
  ) {
    throw new Error("Invalid Codex native pending assignment metadata.");
  }
  return parsed.data;
}

function mergeNativeAssignmentMetadata(
  current: CodexNativeSubagentPendingAssignment,
  incoming: CodexNativeSubagentPendingAssignment,
): void {
  const genericRunId = codexNativeSubagentRunId(current.childThreadId);
  if (
    (current.runId !== incoming.runId &&
      current.runId !== genericRunId &&
      incoming.runId !== genericRunId) ||
    (current.submission &&
      incoming.submission &&
      !isDeepStrictEqual(current.submission, incoming.submission)) ||
    (current.recordedCompletion &&
      incoming.recordedCompletion &&
      !isDeepStrictEqual(current.recordedCompletion, incoming.recordedCompletion))
  ) {
    throw new Error("Conflicting Codex native pending assignment metadata.");
  }
  // A resumed turn still needs its original submission locator to retire the receipt.
  if (current.runId === genericRunId) {
    current.runId = incoming.runId;
  }
  if (incoming.submission) {
    current.submission = incoming.submission;
  }
  if (incoming.recordedCompletion) {
    current.recordedCompletion = incoming.recordedCompletion;
  }
}

/** Doctor and binding writes merge compatible facts for one obligation, never distinct turns. */
export function normalizeNativePendingAssignments(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  const inventory = inventorySchema.parse(value);
  return { version: 1 as const, assignments: mergeNativePendingAssignments(inventory.assignments) };
}

function mergeNativePendingAssignments(entries: CodexNativeSubagentPendingAssignment[]) {
  const assignments: CodexNativeSubagentPendingAssignment[] = [];
  for (const entry of entries) {
    const existing = assignments.find(
      (saved) =>
        saved.childThreadId === entry.childThreadId &&
        saved.nativeTurnId === entry.nativeTurnId &&
        (entry.nativeTurnId !== undefined || saved.runId === entry.runId),
    );
    if (!existing) {
      assignments.push(entry);
      continue;
    }
    if (
      existing.nativeParentThreadId !== entry.nativeParentThreadId ||
      !isDeepStrictEqual(existing.owner, entry.owner)
    ) {
      throw new Error("Conflicting Codex native pending assignment metadata.");
    }
    mergeNativeAssignmentMetadata(existing, entry);
  }
  if (new Set(assignments.map((entry) => entry.runId)).size !== assignments.length) {
    throw new Error("Conflicting Codex native pending assignment metadata.");
  }
  return assignments;
}

export function mutateNativePendingAssignments(params: {
  current: unknown;
  owner: CodexNativeSubagentHistoryOwner;
  assignment: CodexNativeSubagentPendingAssignment;
  consume: boolean;
}) {
  const current = normalizeNativePendingAssignments(params.current);
  let { assignment } = params;
  if (!matchesNativeAssignmentLifecycle(assignment.owner, params.owner)) {
    return { applied: false };
  }
  const assignments = current?.assignments ?? [];
  const existing =
    assignments.find((entry) => entry.runId === assignment.runId) ??
    assignments.find(
      (entry) =>
        assignment.nativeTurnId !== undefined &&
        entry.childThreadId === assignment.childThreadId &&
        entry.nativeTurnId === assignment.nativeTurnId,
    );
  if (params.consume && !existing) {
    return { applied: false, absent: true };
  }
  if (
    (existing &&
      (!isDeepStrictEqual(existing.owner, assignment.owner) ||
        existing.nativeParentThreadId !== assignment.nativeParentThreadId ||
        existing.childThreadId !== assignment.childThreadId)) ||
    (params.consume && existing?.nativeTurnId !== assignment.nativeTurnId)
  ) {
    return { applied: false };
  }
  const remaining = assignments.filter((entry) => entry !== existing);
  if (!params.consume) {
    if (existing && existing.nativeTurnId === assignment.nativeTurnId) {
      mergeNativeAssignmentMetadata(existing, assignment);
      assignment = existing;
    } else if (existing?.recordedCompletion && !assignment.recordedCompletion) {
      assignment = { ...assignment, recordedCompletion: existing.recordedCompletion };
    }
    remaining.push(assignment);
  }
  const next =
    !params.consume && existing && existing.nativeTurnId !== assignment.nativeTurnId
      ? mergeNativePendingAssignments(remaining)
      : remaining;
  return {
    applied: true,
    next: next.length ? { version: 1 as const, assignments: next } : undefined,
    consumed: params.consume ? existing : undefined,
  };
}
