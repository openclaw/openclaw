// Workboard plugin module registers the Feed gateway methods: owner decisions on cards.
import { randomUUID } from "node:crypto";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import { checkFeedSnoozeTime } from "./feed-normalize.js";
import {
  buildFeedActionMessage,
  buildFeedCommentMessage,
  findFeedAction,
  resolveFeedNotifySession,
  resolveOwnerDraft,
  resolveWorkboardFeedConfig,
  FEED_EMPTY_DRAFT_ERROR,
  routeFeedMessage,
  selectFeedCards,
} from "./feed.js";
import { readId, type GatewayMethodContext } from "./gateway-helpers.js";
import type { WorkboardStore } from "./store.js";

type RegisterMethod = (
  method: string,
  scope: "operator.read" | "operator.write",
  handler: (request: GatewayMethodContext) => unknown,
) => void;

function readIdempotencyKey(params: Record<string, unknown>): string {
  const value = params.idempotencyKey;
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 200)
    : `workboard-feed:${randomUUID()}`;
}

function readOptionalText(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function readSnoozeUntil(params: Record<string, unknown>, now: number): number | null {
  const until = params.until;
  if (until === null) {
    return null;
  }
  if (typeof until !== "number") {
    throw new Error("until must be a time in epoch milliseconds, or null to unsnooze.");
  }
  return checkFeedSnoozeTime(until, now);
}

export function registerWorkboardFeedGatewayMethods(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  register: RegisterMethod;
}) {
  const { api, store, register } = params;
  const config = resolveWorkboardFeedConfig(api.pluginConfig);
  const requireCard = async (id: string): Promise<WorkboardCard> => {
    const card = await store.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return card;
  };

  register("workboard.feed.list", "operator.read", async () => ({
    cards: selectFeedCards(await store.list(), config).map(redactClaimToken),
    boards: config.boards,
    ...(config.ownerName ? { ownerName: config.ownerName } : {}),
  }));
  register("workboard.feed.update", "operator.write", async ({ params: input }) => {
    const draft = input.draft;
    if (draft !== null && typeof draft !== "string") {
      throw new Error("draft must be a string or null.");
    }
    if (typeof draft === "string" && !draft.trim()) {
      throw new Error(FEED_EMPTY_DRAFT_ERROR);
    }
    return {
      card: redactClaimToken(await store.setOwnerFeedDraft(readId(input), draft)),
    };
  });
  register("workboard.feed.ack", "operator.write", async ({ params: input }) => ({
    card: redactClaimToken(await store.ackFeed(readId(input), { acked: input.acked !== false })),
  }));
  register("workboard.feed.snooze", "operator.write", async ({ params: input }) => {
    const until = readSnoozeUntil(input, Date.now());
    // Snoozing is silent: it only hides the card from the owner, no agent is told.
    return { card: redactClaimToken(await store.snoozeFeed(readId(input), until)) };
  });
  register("workboard.feed.act", "operator.write", async ({ params: input }) => {
    const card = await requireCard(readId(input));
    const action = findFeedAction(card, input.actionId);
    if (!action) {
      throw new Error(`card ${card.id} has no feed action ${String(input.actionId)}.`);
    }
    const draft = resolveOwnerDraft(card, readOptionalText(input, "draft"));
    const editedDraft = draft.edited;
    // Route before acking: a failed send leaves the card open for another try. The ack keeps
    // the time from before the send, so an agent reply that lands first still reopens the card.
    const touchedAt = Date.now();
    const routed = await routeFeedMessage({
      gateway: api.runtime.gateway,
      sessionKey: resolveFeedNotifySession(card),
      message: buildFeedActionMessage({ card, action, config, editedDraft }),
      idempotencyKey: readIdempotencyKey(input),
    });
    const acked = await store.ackFeed(card.id, {
      acked: true,
      at: touchedAt,
      actionId: action.id,
      ...(draft.changed && editedDraft !== undefined ? { draft: editedDraft } : {}),
    });
    return { card: redactClaimToken(acked), routed };
  });
  register("workboard.feed.comment", "operator.write", async ({ params: input }) => {
    const card = await requireCard(readId(input));
    const body = readOptionalText(input, "body")?.trim();
    if (!body) {
      throw new Error("comment body is required.");
    }
    const draft = resolveOwnerDraft(card, readOptionalText(input, "draft"));
    const touchedAt = Date.now();
    const routed = await routeFeedMessage({
      gateway: api.runtime.gateway,
      sessionKey: resolveFeedNotifySession(card),
      message: buildFeedCommentMessage({ card, body, config, editedDraft: draft.edited }),
      idempotencyKey: readIdempotencyKey(input),
    });
    if (draft.changed && draft.edited !== undefined) {
      await store.setOwnerFeedDraft(card.id, draft.edited);
    }
    const commented = await store.addComment(card.id, {
      body,
      author: { kind: "owner" },
      ackFeed: true,
      createdAt: touchedAt,
    });
    return { card: redactClaimToken(commented), routed };
  });
}
