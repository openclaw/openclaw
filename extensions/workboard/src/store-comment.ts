import type { WorkboardCard, WorkboardComment } from "@openclaw/workboard-contract";
import { assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { MAX_CARD_COMMENTS } from "./store-constants.js";
import type { WorkboardCardPatch, WorkboardMutationScope } from "./store-inputs.js";

export function buildCommentPatch(
  existing: WorkboardCard,
  comment: WorkboardComment,
  kind: unknown,
  scope?: WorkboardMutationScope,
): WorkboardCardPatch {
  assertCanMutateClaimedCard(existing, scope);
  const unresolvedFailure = kind === "failure-feedback";
  return {
    ...(unresolvedFailure && existing.status === "done" ? { status: "review" } : {}),
    metadata: {
      ...existing.metadata,
      comments: [...(existing.metadata?.comments ?? []), comment].slice(-MAX_CARD_COMMENTS),
    },
  };
}
