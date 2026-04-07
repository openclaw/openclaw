/**
 * Template Card Manager
 *
 * Responsible for:
 * - Template card cache management (in-memory, with TTL and size limits)
 * - Card interaction event handling (updating card UI state)
 * - Template card sending (proactive push via wsClient.sendMessage)
 * - Detecting and processing template cards from LLM replies
 */

import type { WSClient, WsFrame, TemplateCard } from "@wecom/aibot-node-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { TEMPLATE_CARD_CACHE_TTL_MS, TEMPLATE_CARD_CACHE_MAX_SIZE } from "./const.js";
import type { MessageState, ExtractedTemplateCard } from "./interface.js";
import type { MessageBody } from "./message-parser.js";
import { extractTemplateCards } from "./template-card-parser.js";
import type { ResolvedWeComAccount } from "./utils.js";

// ============================================================================
// Template Card Cache
// ============================================================================

interface SentTemplateCardCacheEntry {
  templateCard: TemplateCard;
  createdAt: number;
}

const sentTemplateCardByTaskId = new Map<string, SentTemplateCardCacheEntry>();

function getTemplateCardCacheKey(accountId: string, taskId: string): string {
  return `${accountId}:${taskId}`;
}

function pruneTemplateCardCache(): void {
  const now = Date.now();

  for (const [key, entry] of sentTemplateCardByTaskId) {
    if (now - entry.createdAt >= TEMPLATE_CARD_CACHE_TTL_MS) {
      sentTemplateCardByTaskId.delete(key);
    }
  }

  if (sentTemplateCardByTaskId.size <= TEMPLATE_CARD_CACHE_MAX_SIZE) {
    return;
  }

  const sortedEntries = [...sentTemplateCardByTaskId.entries()].toSorted(
    (a, b) => a[1].createdAt - b[1].createdAt,
  );
  const removeCount = sentTemplateCardByTaskId.size - TEMPLATE_CARD_CACHE_MAX_SIZE;
  for (const [key] of sortedEntries.slice(0, removeCount)) {
    sentTemplateCardByTaskId.delete(key);
  }
}

function cloneTemplateCard(card: TemplateCard): TemplateCard {
  return JSON.parse(JSON.stringify(card)) as TemplateCard;
}

export function saveTemplateCardToCache(params: {
  accountId: string;
  templateCard: TemplateCard;
  runtime: RuntimeEnv;
}): void {
  const { accountId, templateCard, runtime } = params;
  const taskId = templateCard.task_id;
  if (!taskId) {
    runtime.log?.("[wecom][template-card] Skip cache: template card has no task_id");
    return;
  }

  sentTemplateCardByTaskId.set(getTemplateCardCacheKey(accountId, taskId), {
    templateCard: cloneTemplateCard(templateCard),
    createdAt: Date.now(),
  });
  pruneTemplateCardCache();
}

export function getTemplateCardFromCache(
  accountId: string,
  taskId: string,
): TemplateCard | undefined {
  pruneTemplateCardCache();
  const cached = sentTemplateCardByTaskId.get(getTemplateCardCacheKey(accountId, taskId));
  if (!cached) {
    return undefined;
  }
  return cloneTemplateCard(cached.templateCard);
}

// ============================================================================
// Template Card Event Update
// ============================================================================

type TemplateCardEventPayload = NonNullable<
  NonNullable<MessageBody["event"]>["template_card_event"]
>;

function buildSelectedOptionMap(
  templateCardEvent?: TemplateCardEventPayload,
): Map<string, string[]> {
  const selectedMap = new Map<string, string[]>();
  const selectedItems = templateCardEvent?.selected_items?.selected_item ?? [];

  for (const item of selectedItems) {
    const questionKey = item.question_key?.trim();
    if (!questionKey) {
      continue;
    }
    const optionIds = item.option_ids?.option_id?.filter(Boolean) ?? [];
    selectedMap.set(questionKey, optionIds);
  }

  return selectedMap;
}

function applySelectedStateToTemplateCard(params: {
  templateCard: TemplateCard;
  selectedMap: Map<string, string[]>;
  templateCardEvent?: TemplateCardEventPayload;
}): TemplateCard {
  const { templateCard, selectedMap, templateCardEvent } = params;
  const nextCard = cloneTemplateCard(templateCard);

  if (templateCardEvent?.task_id) {
    nextCard.task_id = templateCardEvent.task_id;
  }
  if (templateCardEvent?.card_type) {
    nextCard.card_type = templateCardEvent.card_type;
  }

  if (nextCard.submit_button?.text) {
    nextCard.submit_button.text = "已提交";
  }

  if (nextCard.checkbox?.question_key) {
    const selectedIds = selectedMap.get(nextCard.checkbox.question_key) ?? [];
    nextCard.checkbox.disable = true;
    if (Array.isArray(nextCard.checkbox.option_list)) {
      nextCard.checkbox.option_list = nextCard.checkbox.option_list.map((option) => ({
        ...option,
        is_checked: selectedIds.includes(option.id),
      }));
    }
  }

  if (Array.isArray(nextCard.select_list)) {
    nextCard.select_list = nextCard.select_list.map((selection) => {
      const selectedIds = selectedMap.get(selection.question_key) ?? [];
      return {
        ...selection,
        disable: true,
        selected_id: selectedIds[0] ?? selection.selected_id,
      };
    });
  }

  if (nextCard.button_selection?.question_key) {
    const selectedIds = selectedMap.get(nextCard.button_selection.question_key) ?? [];
    nextCard.button_selection.disable = true;
    if (selectedIds[0]) {
      nextCard.button_selection.selected_id = selectedIds[0];
    }
  }

  return nextCard;
}

export async function updateTemplateCardOnEvent(params: {
  frame: WsFrame;
  accountId: string;
  runtime: RuntimeEnv;
  wsClient: WSClient;
}): Promise<void> {
  const { frame, accountId, runtime, wsClient } = params;
  const body = frame.body as MessageBody;
  const templateCardEvent = body.event?.template_card_event;
  const taskId = templateCardEvent?.task_id;

  if (!taskId) {
    runtime.log?.(`[${accountId}] [template-card-update] Skip update: missing task_id in callback`);
    return;
  }

  const cachedCard = getTemplateCardFromCache(accountId, taskId);
  if (!cachedCard) {
    runtime.log?.(
      `[${accountId}] [template-card-update] Skip update: task_id=${taskId} not found in cache (cache is in-memory only, may have been cleared after restart)`,
    );
    return;
  }

  const selectedMap = buildSelectedOptionMap(templateCardEvent);
  const updatedCard = applySelectedStateToTemplateCard({
    templateCard: cachedCard,
    selectedMap,
    templateCardEvent,
  });

  await wsClient.updateTemplateCard(frame, updatedCard, [body.from.userid]);
  runtime.log?.(`[${accountId}] [template-card-update] Updated card by task_id=${taskId}`);

  saveTemplateCardToCache({
    accountId,
    templateCard: updatedCard,
    runtime,
  });
}

// ============================================================================
// Template Card Sending
// ============================================================================

/**
 * Sends extracted template cards one by one (proactive push via wsClient.sendMessage).
 *
 * Send failures do not block the flow; only error logs are recorded.
 */
export async function sendTemplateCards(params: {
  wsClient: WSClient;
  frame: WsFrame;
  state: MessageState;
  account: ResolvedWeComAccount;
  runtime: RuntimeEnv;
  cards: ExtractedTemplateCard[];
}): Promise<void> {
  const { wsClient, frame, state, runtime, account, cards } = params;
  const body = frame.body as MessageBody;
  const chatId = body.chatid || body.from.userid;

  for (const card of cards) {
    try {
      runtime.log?.(
        `[wecom][template-card] Sending card_type=${card.cardType} to chatId=${chatId}`,
      );

      const rawTemplateCard = card.cardJson;
      if (typeof rawTemplateCard.card_type !== "string") {
        runtime.error?.("[wecom][template-card] Skip sending invalid card: missing card_type");
        continue;
      }

      const templateCard = rawTemplateCard as unknown as TemplateCard;
      await wsClient.sendMessage(chatId, {
        msgtype: "template_card",
        template_card: templateCard,
      });
      state.hasTemplateCard = true;
      saveTemplateCardToCache({
        accountId: account.accountId,
        templateCard,
        runtime,
      });
      runtime.log?.(`[wecom][template-card] Card sent successfully: card_type=${card.cardType}`);
    } catch (err) {
      runtime.error?.(
        `[wecom][template-card] Failed to send card: card_type=${card.cardType}, error=${JSON.stringify(err)}`,
      );
    }
  }
}

// ============================================================================
// Template Card Detection and Processing (extracted from finishThinkingStream)
// ============================================================================

/**
 * Detects and sends template cards from accumulated text.
 *
 * Called before finishThinkingStream to decouple card processing from stream closing.
 *
 * @returns The remaining text after removing card code blocks (null if no cards detected, meaning no modification needed)
 */
export async function processTemplateCardsIfNeeded(params: {
  wsClient: WSClient;
  frame: WsFrame;
  state: MessageState;
  account: ResolvedWeComAccount;
  runtime: RuntimeEnv;
}): Promise<{ remainingText: string; cardsDetected: boolean } | null> {
  const { state, runtime } = params;
  const visibleText = state.accumulatedText?.trim();

  if (!visibleText) {
    runtime.log?.(`[wecom][template-card] processTemplateCardsIfNeeded: no visibleText, skipping`);
    return null;
  }

  runtime.log?.(
    `[wecom][template-card] processTemplateCardsIfNeeded: visibleText exists, length=${visibleText.length}, running extractTemplateCards...`,
  );
  const logFn = (...args: unknown[]): void => {
    runtime.log?.(...args);
  };
  const { cards, remainingText } = extractTemplateCards(state.accumulatedText, logFn);

  runtime.log?.(
    `[wecom][template-card] processTemplateCardsIfNeeded: extractTemplateCards result — cards=${cards.length}, remainingTextLength=${remainingText.length}`,
  );

  if (cards.length === 0) {
    return null;
  }

  runtime.log?.(
    `[wecom][template-card] processTemplateCardsIfNeeded: ${cards.length} card(s) detected, card_types=[${cards.map((c) => c.cardType).join(", ")}]`,
  );
  await sendTemplateCards({ ...params, cards });

  return { remainingText, cardsDetected: true };
}
