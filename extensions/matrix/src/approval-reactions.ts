// Matrix plugin module implements approval reactions behavior.
import { createApprovalReactionTargetStore } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";
import { getOptionalMatrixRuntime } from "./runtime.js";

// Matrix keeps its own reaction emoji set (checkmark/cross render reliably across
// Matrix clients), so decision resolution stays local instead of using the SDK bindings.
const MATRIX_APPROVAL_REACTION_META = {
  "allow-once": {
    emoji: "✅",
    label: "Allow once",
  },
  "allow-always": {
    emoji: "♾️",
    label: "Allow always",
  },
  deny: {
    emoji: "❌",
    label: "Deny",
  },
} satisfies Record<ExecApprovalReplyDecision, { emoji: string; label: string }>;

const MATRIX_APPROVAL_REACTION_ORDER = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalReplyDecision[];

const PERSISTENT_NAMESPACE = "matrix.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

type MatrixApprovalReactionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

type MatrixApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};

type MatrixApprovalReactionTarget = {
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalMatrixRuntime()
      ?.logging.getChildLogger({ plugin: "matrix", feature: "approval-reaction-state" })
      .warn("Matrix persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Matrix reactions.
  }
}

function readPersistedTarget(target: unknown): MatrixApprovalReactionTarget | null {
  const value = target as Partial<MatrixApprovalReactionTarget> | null | undefined;
  if (!value || typeof value.approvalId !== "string" || !Array.isArray(value.allowedDecisions)) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    allowedDecisions: value.allowedDecisions,
  };
}

const matrixApprovalReactionTargets =
  createApprovalReactionTargetStore<MatrixApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (storeParams) => getOptionalMatrixRuntime()?.state.openKeyedStore(storeParams),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

function buildReactionTargetKey(roomId: string, eventId: string): string | null {
  const normalizedRoomId = roomId.trim();
  const normalizedEventId = eventId.trim();
  if (!normalizedRoomId || !normalizedEventId) {
    return null;
  }
  return `${normalizedRoomId}:${normalizedEventId}`;
}

export function listMatrixApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): MatrixApprovalReactionBinding[] {
  const allowed = new Set(allowedDecisions);
  return MATRIX_APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision)).map(
    (decision) => ({
      decision,
      emoji: MATRIX_APPROVAL_REACTION_META[decision].emoji,
      label: MATRIX_APPROVAL_REACTION_META[decision].label,
    }),
  );
}

export function buildMatrixApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  const bindings = listMatrixApprovalReactionBindings(allowedDecisions);
  if (bindings.length === 0) {
    return null;
  }
  return `React here: ${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join(", ")}`;
}

function resolveMatrixApprovalReactionDecision(
  reactionKey: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalReplyDecision | null {
  const normalizedReaction = reactionKey.trim();
  if (!normalizedReaction) {
    return null;
  }
  const allowed = new Set(allowedDecisions);
  for (const decision of MATRIX_APPROVAL_REACTION_ORDER) {
    if (!allowed.has(decision)) {
      continue;
    }
    if (MATRIX_APPROVAL_REACTION_META[decision].emoji === normalizedReaction) {
      return decision;
    }
  }
  return null;
}

export function registerMatrixApprovalReactionTarget(params: {
  roomId: string;
  eventId: string;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): void {
  const key = buildReactionTargetKey(params.roomId, params.eventId);
  const approvalId = params.approvalId.trim();
  const allowedDecisions = Array.from(
    new Set(
      params.allowedDecisions.filter(
        (decision): decision is ExecApprovalReplyDecision =>
          decision === "allow-once" || decision === "allow-always" || decision === "deny",
      ),
    ),
  );
  if (!key || !approvalId || allowedDecisions.length === 0) {
    return;
  }
  matrixApprovalReactionTargets.register(
    key,
    { approvalId, allowedDecisions },
    { ttlMs: params.ttlMs },
  );
}

export function unregisterMatrixApprovalReactionTarget(params: {
  roomId: string;
  eventId: string;
}): void {
  const key = buildReactionTargetKey(params.roomId, params.eventId);
  if (!key) {
    return;
  }
  matrixApprovalReactionTargets.delete(key);
}

function resolveTarget(params: {
  target: MatrixApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): MatrixApprovalReactionResolution | null {
  const target = params.target;
  if (!target) {
    return null;
  }
  const decision = resolveMatrixApprovalReactionDecision(
    params.reactionKey,
    target.allowedDecisions,
  );
  if (!decision) {
    return null;
  }
  return {
    approvalId: target.approvalId,
    decision,
  };
}

export async function resolveMatrixApprovalReactionTargetWithPersistence(params: {
  roomId: string;
  eventId: string;
  reactionKey: string;
}): Promise<MatrixApprovalReactionResolution | null> {
  const key = buildReactionTargetKey(params.roomId, params.eventId);
  if (!key) {
    return null;
  }
  return resolveTarget({
    target: await matrixApprovalReactionTargets.lookup(key),
    reactionKey: params.reactionKey,
  });
}

export function clearMatrixApprovalReactionTargetsForTest(): void {
  matrixApprovalReactionTargets.clearForTest();
}
