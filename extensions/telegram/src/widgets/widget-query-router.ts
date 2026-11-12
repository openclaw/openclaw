import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { readRuntimeConfig as getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramAccount } from "../accounts.js";
import type { TelegramCallbackMessageRuntime } from "../bot-handlers.callback-router-controls.js";
import type { TelegramHandlerAuthorization } from "../bot-handlers.inbound-authorization.js";
import {
  buildSyntheticContext,
  buildSyntheticTextMessage,
} from "../bot-handlers.message-context.js";
import type { RegisterTelegramHandlerParams } from "../bot-handlers.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  resolveTelegramUpdateReceivedAtSeconds,
} from "../bot-processing-outcome.js";
import { resolveTelegramMessageThreadSpec } from "../bot/helpers.js";
import { readTelegramWidgetQuery, type TelegramWidgetQuery } from "./widget-bot-api.js";
import { TELEGRAM_WIDGET_REQUEST_PREFIX } from "./widget-guidance.js";
import { lookupTelegramSentWidget, recordTelegramWidgetTap } from "./widget-store.js";

// Same budget as Control UI widget prompts: 10 per minute per widget.
const WIDGET_REQUEST_WINDOW_MS = 60_000;
const WIDGET_REQUEST_MAX_PER_WINDOW = 10;
const WIDGET_REQUEST_GATE_MAX_KEYS = 500;
const TAP_SOURCE_MAX_CHARS = 8_000;

type WidgetRequestHistory = { at: number; data: string; queryId: string }[];

/**
 * Telegram cannot tell a tap from a widget's background request, so the router admits a
 * request text once per window per widget. A widget polling with the same data reaches the
 * agent once; a person tapping different buttons is not limited beyond the window budget.
 */
export function createTelegramWidgetRequestGate(now: () => number = Date.now) {
  const history = new Map<string, WidgetRequestHistory>();
  return (key: string, data: string, queryId: string): boolean => {
    const at = now();
    const recent = (history.get(key) ?? []).filter(
      (entry) => at - entry.at < WIDGET_REQUEST_WINDOW_MS,
    );
    // Durable ingress replays a retryable query under the same id; it was already admitted.
    if (recent.some((entry) => entry.queryId === queryId)) {
      return true;
    }
    if (
      recent.length >= WIDGET_REQUEST_MAX_PER_WINDOW ||
      recent.some((entry) => entry.data === data)
    ) {
      history.set(key, recent);
      return false;
    }
    recent.push({ at, data, queryId });
    history.delete(key);
    history.set(key, recent);
    if (history.size > WIDGET_REQUEST_GATE_MAX_KEYS) {
      const oldest = history.keys().next().value;
      if (oldest !== undefined) {
        history.delete(oldest);
      }
    }
    return true;
  };
}

/**
 * The tap turn may run before the agent has loaded show_widget, so the request names its
 * widget and how to answer in place.
 */
function formatTelegramWidgetRequestText(
  data: string,
  widget?: { title: string; state?: string; source?: string },
): string {
  const named = widget ? `the widget "${widget.title}"` : "a widget you sent";
  const state = widget?.state
    ? ` Its current state is ${JSON.stringify(widget.state)}; keep the shape its code reads.`
    : "";
  // The tap can land in a later session that never saw the widget; its code shows the state shape.
  const code =
    widget?.source && widget.source.length <= TAP_SOURCE_MAX_CHARS
      ? `\nWidget code:\n${widget.source}`
      : "";
  return `${TELEGRAM_WIDGET_REQUEST_PREFIX} ${data}\n(The user tapped ${named}.${state} Answer by calling show_widget with the same title and only the new state, which updates that widget in place, then reply NO_REPLY.)${code}`;
}

function isAdmissibleWidgetRequestText(data: string): boolean {
  // Parity with Control UI widget prompts: no slash commands or shell escapes from widget code.
  return data.length > 0 && !data.startsWith("/") && !data.startsWith("!");
}

export function createTelegramWidgetQueryRouter({
  params: { accountId, runtime },
  message: { processMessageWithReplyChain },
  authorization: { resolveTelegramEventAuthorizationContext, authorizeTelegramEventSender },
  admit = createTelegramWidgetRequestGate(),
}: {
  params: Pick<RegisterTelegramHandlerParams, "accountId" | "runtime">;
  message: Pick<TelegramCallbackMessageRuntime, "processMessageWithReplyChain">;
  authorization: Pick<
    TelegramHandlerAuthorization,
    "resolveTelegramEventAuthorizationContext" | "authorizeTelegramEventSender"
  >;
  admit?: ReturnType<typeof createTelegramWidgetRequestGate>;
}) {
  const handleQuery = async (ctx: Context, query: TelegramWidgetQuery) => {
    // Widgets reach production only in private chats; groups and inline copies stay unrouted.
    if (query.chat.type !== "private") {
      return;
    }
    // Widgets are opt-in; a tap on a widget sent before they were turned off is dropped.
    const authorizationCfg = getRuntimeConfig();
    if (resolveTelegramAccount({ cfg: authorizationCfg, accountId }).config.widgets !== true) {
      logVerbose("telegram: widget request dropped; widgets are disabled for this account");
      return;
    }
    const data = query.data.trim();
    const chatId = query.chat.id;
    const widgetKey = `${chatId}:${query.message_id}`;
    if (!isAdmissibleWidgetRequestText(data) || !admit(widgetKey, data, query.id)) {
      logVerbose(`telegram: widget request dropped for ${widgetKey}`);
      return;
    }
    const sent = await lookupTelegramSentWidget({
      accountId,
      chatId: String(chatId),
      messageId: query.message_id,
    });
    const widgetMessage: Message = {
      message_id: query.message_id,
      date: resolveTelegramUpdateReceivedAtSeconds(ctx.update),
      chat: query.chat,
      from: ctx.me,
      ...(sent ? { caption: sent.title } : {}),
    };
    const threadSpec = resolveTelegramMessageThreadSpec(widgetMessage, false);
    const senderId = String(query.from.id);
    const eventAuthContext = await resolveTelegramEventAuthorizationContext({
      cfg: authorizationCfg,
      chatId,
      isGroup: false,
      senderId,
      threadSpec,
    });
    const authorized = await authorizeTelegramEventSender({
      chatId,
      isGroup: false,
      senderId,
      mode: "callback-allowlist",
      context: eventAuthContext,
    });
    if (!authorized) {
      return;
    }
    await recordTelegramWidgetTap({
      accountId,
      queryId: query.id,
      tap: { chatId: String(chatId), messageId: query.message_id },
    });
    // The request replies to the widget, so the agent sees which widget asked.
    const syntheticMessage: Message = {
      ...buildSyntheticTextMessage({
        base: widgetMessage,
        from: query.from,
        text: formatTelegramWidgetRequestText(data, sent),
        date: resolveTelegramUpdateReceivedAtSeconds(ctx.update),
      }),
      reply_to_message: { ...widgetMessage, reply_to_message: undefined },
    };
    const result = await processMessageWithReplyChain({
      ctx: buildSyntheticContext(ctx, syntheticMessage),
      msg: syntheticMessage,
      allMedia: [],
      storeAllowFrom: eventAuthContext.storeAllowFrom,
      options: {
        threadSpec: eventAuthContext.threadSpec,
        forceWasMentioned: true,
        messageIdOverride: query.id,
      },
    });
    if (result?.kind === "failed-retryable") {
      recordTelegramMessageProcessingResult(result);
    }
  };

  return {
    async route(ctx: Context, next: () => Promise<void>) {
      const query = readTelegramWidgetQuery(ctx.update);
      if (!query) {
        await next();
        return;
      }
      try {
        await handleQuery(ctx, query);
      } catch (error) {
        runtime.error?.(danger(`widget query handler failed: ${String(error)}`));
        // The query was acknowledged at admission; keep it retryable instead of tombstoning it.
        if (isTelegramSpooledReplayUpdate(ctx.update)) {
          recordTelegramMessageProcessingResult({ kind: "failed-retryable", error });
          return;
        }
        throw error;
      }
    },
  };
}
