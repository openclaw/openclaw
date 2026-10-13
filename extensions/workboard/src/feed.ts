// Workboard plugin module selects Feed cards and routes owner decisions to agents.
import type { WorkboardCard, WorkboardFeedAction } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { feedHasPresentation } from "./feed-normalize.js";
import { cardBoardId } from "./store-card-helpers.js";

export const FEED_FALLBACK_NOTIFY_SESSION = "agent:main:main";
const FEED_DEFAULT_OWNER_NAME = "The owner";
const FEED_MESSAGE_PREFIX = "[Feed]";
export const FEED_EMPTY_DRAFT_ERROR = "The draft is empty. Write the text or cancel the edit.";

export type WorkboardFeedConfig = {
  /** Every card on these boards shows in the Feed, with or without feed metadata. */
  boards: string[];
  ownerName?: string;
};

export function resolveWorkboardFeedConfig(pluginConfig: unknown): WorkboardFeedConfig {
  const feed = isRecord(pluginConfig) && isRecord(pluginConfig.feed) ? pluginConfig.feed : {};
  const boards = Array.isArray(feed.boards)
    ? feed.boards.filter(
        (board): board is string => typeof board === "string" && board.trim() !== "",
      )
    : [];
  const ownerName =
    typeof feed.ownerName === "string" && feed.ownerName.trim() ? feed.ownerName.trim() : undefined;
  return { boards: boards.map((board) => board.trim()), ...(ownerName ? { ownerName } : {}) };
}

/** Open and recently handled cards that belong in the Feed. Done cards stay for the handled list. */
export function selectFeedCards(
  cards: readonly WorkboardCard[],
  config: WorkboardFeedConfig,
): WorkboardCard[] {
  const boards = new Set(config.boards);
  return cards.filter(
    (card) =>
      !card.metadata?.archivedAt &&
      (boards.has(cardBoardId(card)) || feedHasPresentation(card.metadata?.feed)),
  );
}

export function resolveFeedNotifySession(card: WorkboardCard): string {
  const notify = card.metadata?.feed?.notify?.trim();
  if (notify) {
    return notify;
  }
  return card.agentId ? `agent:${card.agentId}:main` : FEED_FALLBACK_NOTIFY_SESSION;
}

function ownerLabel(config: WorkboardFeedConfig): string {
  return config.ownerName ?? FEED_DEFAULT_OWNER_NAME;
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function replyInstructions(card: WorkboardCard): string {
  return [
    `To answer, call workboard_comment with id "${card.id}"; the card comes back to the top of the Feed with your reply.`,
    `When the work is finished, move the card to done with workboard_move.`,
  ].join(" ");
}

/**
 * The draft text to send with an owner decision. `changed` is a new edit from this request;
 * otherwise a draft the owner saved earlier still counts as edited.
 */
export function resolveOwnerDraft(
  card: WorkboardCard,
  draft: string | undefined,
): { edited?: string; changed: boolean } {
  const feed = card.metadata?.feed;
  if (draft !== undefined && !draft.trim()) {
    throw new Error(FEED_EMPTY_DRAFT_ERROR);
  }
  if (draft !== undefined && draft !== feed?.draft) {
    return { edited: draft, changed: true };
  }
  return feed?.draftEdited && feed.draft
    ? { edited: feed.draft, changed: false }
    : { changed: false };
}

function editedDraftLines(editedDraft: string | undefined): string[] {
  return editedDraft === undefined
    ? []
    : ["", "They edited the draft first. Use this text:", quoteBlock(editedDraft)];
}

export function buildFeedActionMessage(params: {
  card: WorkboardCard;
  action: WorkboardFeedAction;
  config: WorkboardFeedConfig;
  editedDraft?: string;
}): string {
  const { card, action, config } = params;
  return [
    `${FEED_MESSAGE_PREFIX} ${ownerLabel(config)} clicked "${action.label}" on card ${card.id} "${card.title}".`,
    "",
    action.message,
    ...editedDraftLines(params.editedDraft),
    "",
    replyInstructions(card),
  ].join("\n");
}

export function buildFeedCommentMessage(params: {
  card: WorkboardCard;
  body: string;
  config: WorkboardFeedConfig;
  editedDraft?: string;
}): string {
  const { card, body, config } = params;
  return [
    `${FEED_MESSAGE_PREFIX} ${ownerLabel(config)} commented on card ${card.id} "${card.title}": ${body}`,
    ...editedDraftLines(params.editedDraft),
    "",
    replyInstructions(card),
  ].join("\n");
}

export function findFeedAction(
  card: WorkboardCard,
  actionId: unknown,
): WorkboardFeedAction | undefined {
  if (typeof actionId !== "string") {
    return undefined;
  }
  return card.metadata?.feed?.actions?.find((action) => action.id === actionId);
}

export type FeedRouteResult = { sessionKey: string; runId?: string };

/** Send the decision into the notify session as an owner message; queues behind a running turn. */
export async function routeFeedMessage(params: {
  gateway: Pick<OpenClawPluginApi["runtime"]["gateway"], "request">;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}): Promise<FeedRouteResult> {
  const result = await params.gateway.request(
    "sessions.send",
    {
      key: params.sessionKey,
      message: params.message,
      idempotencyKey: params.idempotencyKey,
    },
    { scopes: ["operator.write"] },
  );
  const runId = isRecord(result) && typeof result.runId === "string" ? result.runId : undefined;
  return { sessionKey: params.sessionKey, ...(runId ? { runId } : {}) };
}
