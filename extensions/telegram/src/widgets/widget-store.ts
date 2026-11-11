import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "../runtime.js";

const log = createSubsystemLogger("telegram/widgets");

const DAY_MS = 24 * 60 * 60 * 1000;

/** A widget OpenClaw sent; taps on it may update it in place while the code is unchanged. */
type TelegramSentWidget = {
  name: string;
  sourceHash: string;
  title: string;
  state?: string;
  /** Kept so a tap turn in a later session can still read the widget's state shape. */
  source?: string;
};
/** A delivered widget tap, keyed by its query id, which is the tap turn's inbound message id. */
type TelegramWidgetTap = { chatId: string; messageId: number };

type WidgetStores = {
  sent: PluginStateKeyedStore<TelegramSentWidget, 2>;
  taps: PluginStateKeyedStore<TelegramWidgetTap, 2>;
};

let stores: WidgetStores | undefined;

function openStores(): WidgetStores {
  // The plugin runtime owns the database; the handles are reusable for its lifetime.
  stores ??= {
    sent: getTelegramRuntime().state.openKeyedStoreV2<TelegramSentWidget>({
      namespace: "telegram.widgets",
      maxEntries: 1_000,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: 30 * DAY_MS,
    }),
    taps: getTelegramRuntime().state.openKeyedStoreV2<TelegramWidgetTap>({
      namespace: "telegram.widget-taps",
      maxEntries: 1_000,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: DAY_MS,
    }),
  };
  return stores;
}

const sentKey = (accountId: string, chatId: string, messageId: number) =>
  `${accountId}:${chatId}:${messageId}`;

export async function recordTelegramSentWidget(params: {
  accountId: string;
  chatId: string;
  messageId: number;
  widget: TelegramSentWidget;
}): Promise<void> {
  // Called after Telegram accepted the widget: the user already sees it, so a bookkeeping failure
  // must not turn into a failed send that the model retries. Taps on it then send new widgets.
  try {
    await openStores().sent.register(
      sentKey(params.accountId, params.chatId, params.messageId),
      params.widget,
    );
  } catch (error) {
    log.warn(`widget record failed for message ${params.messageId}: ${formatErrorMessage(error)}`);
  }
}

export async function lookupTelegramSentWidget(params: {
  accountId: string;
  chatId: string;
  messageId: number;
}): Promise<TelegramSentWidget | undefined> {
  return await openStores().sent.lookup(sentKey(params.accountId, params.chatId, params.messageId));
}

export async function recordTelegramWidgetTap(params: {
  accountId: string;
  queryId: string;
  tap: TelegramWidgetTap;
}): Promise<void> {
  await openStores().taps.register(`${params.accountId}:${params.queryId}`, params.tap);
}

export async function lookupTelegramWidgetTap(params: {
  accountId: string;
  queryId: string;
}): Promise<TelegramWidgetTap | undefined> {
  return await openStores().taps.lookup(`${params.accountId}:${params.queryId}`);
}
