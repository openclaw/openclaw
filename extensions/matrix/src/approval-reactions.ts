import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";

const APPROVE_COMMAND_REGEX =
  /\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i;

function parseExecApprovalCommandText(
  raw: string,
): { approvalId: string; decision: ExecApprovalReplyDecision } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(APPROVE_COMMAND_REGEX);
  if (!match) {
    return null;
  }
  const rawDecision = (match[2] ?? "").toLowerCase();
  return {
    approvalId: match[1] ?? "",
    decision:
      rawDecision === "always" ? "allow-always" : (rawDecision as ExecApprovalReplyDecision),
  };
}

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

export type MatrixApprovalReactionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

export type MatrixApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};

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

export function resolveMatrixApprovalReactionDecision(
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

export function resolveMatrixApprovalReactionTarget(
  messageText: string,
  reactionKey: string,
): MatrixApprovalReactionResolution | null {
  const allowedDecisions = new Set<ExecApprovalReplyDecision>();
  let approvalId: string | null = null;
  for (const line of messageText.split(/\r?\n/)) {
    const parsed = parseExecApprovalCommandText(line);
    if (!parsed) {
      continue;
    }
    if (approvalId && approvalId !== parsed.approvalId) {
      return null;
    }
    approvalId = parsed.approvalId;
    allowedDecisions.add(parsed.decision);
  }
  if (!approvalId || allowedDecisions.size === 0) {
    return null;
  }
  const decision = resolveMatrixApprovalReactionDecision(reactionKey, Array.from(allowedDecisions));
  if (!decision) {
    return null;
  }
  return {
    approvalId,
    decision,
  };
}
