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
  .strict()
  .refine(
    ({ assignments }) =>
      new Set(assignments.map((entry) => entry.runId)).size === assignments.length,
  );

export type CodexNativeSubagentPendingAssignment = z.infer<typeof assignmentSchema>;
export type CodexNativeSubagentAssignmentStore = {
  assertCurrent(): void;
  read(): readonly CodexNativeSubagentPendingAssignment[];
  record(
    assignment: CodexNativeSubagentPendingAssignment,
    assertCurrent: () => void,
  ): Promise<boolean>;
  consume(
    assignment: CodexNativeSubagentPendingAssignment,
    assertCurrent: () => void,
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
  if (!parsed.success) {
    throw new Error("Invalid Codex native pending assignment metadata.");
  }
  return parsed.data;
}

export function mutateNativePendingAssignments(params: {
  current: unknown;
  owner: CodexNativeSubagentHistoryOwner;
  assignment: CodexNativeSubagentPendingAssignment;
  consume: boolean;
}) {
  const current = readNativePendingAssignments(params.current);
  const assignment = assignmentSchema.parse(params.assignment);
  const owner = codexNativeSubagentHistoryOwnerSchema.parse(params.owner);
  if (!matchesNativeAssignmentLifecycle(assignment.owner, owner)) {
    return { applied: false };
  }
  const assignments = current?.assignments ?? [];
  const existing = assignments.find((entry) => entry.runId === assignment.runId);
  if (
    existing &&
    (!isDeepStrictEqual(existing.owner, assignment.owner) ||
      existing.nativeParentThreadId !== assignment.nativeParentThreadId ||
      existing.childThreadId !== assignment.childThreadId)
  ) {
    return { applied: false };
  }
  if (params.consume && (!existing || existing.nativeTurnId !== assignment.nativeTurnId)) {
    return { applied: false };
  }
  const remaining = assignments.filter((entry) => entry !== existing);
  if (!params.consume) {
    remaining.push(
      existing?.recordedCompletion && !assignment.recordedCompletion
        ? { ...assignment, recordedCompletion: existing.recordedCompletion }
        : assignment,
    );
  }
  return {
    applied: true,
    next: remaining.length ? { version: 1 as const, assignments: remaining } : undefined,
  };
}
