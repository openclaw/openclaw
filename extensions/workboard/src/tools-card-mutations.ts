import type { WorkboardCard } from "@openclaw/workboard-contract";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { asRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type, type TProperties } from "typebox";
import { redactClaimToken } from "./card-redaction.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import type { WorkboardStore } from "./store.js";

function canMutateCard(card: WorkboardCard, ownerId: string, token?: string): boolean {
  const claim = card.metadata?.claim;
  return !claim || claim.ownerId === ownerId || safeEqualSecret(token, claim.token);
}

export async function requireScopedCard(
  store: WorkboardStore,
  cardId: string,
  ownerId: string,
  token?: string,
): Promise<WorkboardCard> {
  const card = await store.get(cardId);
  if (!card) {
    throw new Error(`card not found: ${cardId}`);
  }
  if (!canMutateCard(card, ownerId, token)) {
    throw new Error(`card is claimed by ${card.metadata?.claim?.ownerId ?? "another agent"}.`);
  }
  return card;
}

type WorkboardToolCardParams = {
  record: Record<string, unknown>;
  id: string;
  scope: WorkboardMutationScope;
};
type WorkboardCardMutation = (
  id: string,
  record: Record<string, unknown>,
  scope: WorkboardToolCardParams["scope"],
) => Promise<WorkboardCard>;

// Card payloads stay nested under `card`: the host grades a tool call from
// reserved keys on `details` (`status`, `ok`, `error`, ...), so a flat card
// would report every mutation of a blocked card as a failed tool call.
function redactedCardResult(card: WorkboardCard) {
  return jsonResult({ card: redactClaimToken(card) });
}

export function createWorkboardCardMutations(store: WorkboardStore, ownerId: string) {
  const readParams = async (
    rawParams: unknown,
    requireClaim = false,
  ): Promise<WorkboardToolCardParams> => {
    const record = asRecord(rawParams);
    const id = readStringParam(record, "id", { required: true });
    const token = readStringValue(record.token);
    const card = await requireScopedCard(store, id, ownerId, token);
    if (requireClaim && !card.metadata?.claim) {
      throw new Error("card must be claimed before lifecycle completion.");
    }
    return { record, id, scope: { ownerId, token } };
  };
  const cardMutation =
    (mutate: WorkboardCardMutation, requireClaim = false) =>
    async (_toolCallId: string, rawParams: unknown) => {
      const { record, id, scope } = await readParams(rawParams, requireClaim);
      return redactedCardResult(await mutate(id, record, scope));
    };
  return {
    readScopedCardToolParams: (rawParams: unknown) => readParams(rawParams),
    scopedCardMutation: (mutate: WorkboardCardMutation) => cardMutation(mutate),
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
      branch: Type.Optional(Type.String({ description: "Suggested branch." })),
    }),
  );
}
