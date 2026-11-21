import type { WorkboardCard } from "@openclaw/workboard-contract";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { asRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type, type TProperties } from "typebox";
import type { WorkboardMutationScope } from "./store-inputs.js";
import type { WorkboardStore } from "./store.js";

type WorkboardCardMutation = (
  id: string,
  record: Record<string, unknown>,
  scope: WorkboardMutationScope,
) => Promise<WorkboardCard>;

export function summarizeWorkboardCard(card: WorkboardCard) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    priority: card.priority,
    agentId: card.agentId,
    tenant: card.metadata?.automation?.tenant,
    boardId: card.metadata?.automation?.boardId ?? "default",
    parents: card.metadata?.links
      ?.filter((link) => link.type === "parent" && link.targetCardId)
      .map((link) => link.targetCardId),
    children: card.metadata?.links
      ?.filter((link) => link.type === "child" && link.targetCardId)
      .map((link) => link.targetCardId),
    claim: card.metadata?.claim
      ? {
          ownerId: card.metadata.claim.ownerId,
          claimedAt: card.metadata.claim.claimedAt,
          lastHeartbeatAt: card.metadata.claim.lastHeartbeatAt,
          expiresAt: card.metadata.claim.expiresAt,
        }
      : undefined,
    diagnostics: card.metadata?.diagnostics,
    archivedAt: card.metadata?.archivedAt,
    updatedAt: card.updatedAt,
  };
}

/** Write tools answer this summary; workboard_read is the path for the full card. */
export function compactCardResult(card: WorkboardCard, extra?: Record<string, unknown>) {
  // Nest cards so their status cannot be mistaken for the tool result's status.
  return jsonResult({ card: summarizeWorkboardCard(card), ...extra });
}

/** Ids of records the write added, which the summary leaves out. */
type CreatedIds = (card: WorkboardCard) => Record<string, unknown>;

export function createWorkboardCardMutations(
  store: WorkboardStore,
  ownerId: string,
  runId: string | undefined,
) {
  const readParams = async (rawParams: unknown, requireClaim = false) => {
    const record = asRecord(rawParams);
    const id = readStringParam(record, "id", { required: true });
    const token = readStringValue(record.token);
    const card = await store.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    const claim = card.metadata?.claim;
    if (claim && claim.ownerId !== ownerId && !safeEqualSecret(token, claim.token)) {
      throw new Error(`card is claimed by ${claim.ownerId ?? "another agent"}.`);
    }
    if (requireClaim && !claim) {
      throw new Error("card must be claimed before lifecycle completion.");
    }
    return { record, id, scope: { ownerId, token, runId } };
  };
  const cardMutation =
    (mutate: WorkboardCardMutation, requireClaim: boolean, created?: CreatedIds) =>
    async (_toolCallId: string, rawParams: unknown) => {
      const { record, id, scope } = await readParams(rawParams, requireClaim);
      const card = await mutate(id, record, scope);
      return compactCardResult(card, created?.(card));
    };
  return {
    readScopedCardToolParams: (rawParams: unknown) => readParams(rawParams),
    scopedCardMutation: (mutate: WorkboardCardMutation, created?: CreatedIds) =>
      cardMutation(mutate, false, created),
    claimedCardMutation: (mutate: WorkboardCardMutation) => cardMutation(mutate, true),
  };
}

export function cardIdField() {
  return Type.String({ description: "Workboard card id." });
}

export function claimTokenField(description = "Claim token returned by workboard_claim.") {
  return Type.Optional(Type.String({ description }));
}

export function strictObject<const Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}

export function workspaceField() {
  return Type.Optional(
    strictObject({
      kind: Type.String({ description: "scratch, dir, or worktree." }),
      path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
      branch: Type.Optional(
        Type.String({
          description:
            "Optional worktree source base ref. Re-dispatch reuses a retained checkout; use a new card for a different base ref.",
        }),
      ),
    }),
  );
}
