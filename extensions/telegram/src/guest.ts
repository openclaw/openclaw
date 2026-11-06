import { AbortController as TelegramAbortController } from "abort-controller";
import type { Bot, Context } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { runAuthorizedTelegramRequest } from "./account-throttler.js";
import { resolveTelegramAccount } from "./accounts.js";
import {
  getTelegramSpooledReplayLifecycle,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { getTelegramRuntime } from "./runtime.js";

const GUEST_TURN_TIMEOUT_MS = 60_000;
const MAX_GUEST_REQUEST_AGE_MS = 5 * 60_000;

function isGuestCallerAllowed(cfg: OpenClawConfig, accountId: string, message: Message): boolean {
  const account = resolveTelegramAccount({ cfg, accountId });
  const from = message.from;
  if (
    !from ||
    from.is_bot ||
    !Number.isSafeInteger(from.id) ||
    from.id <= 0 ||
    message.sender_chat
  ) {
    return false;
  }
  return (
    account.enabled &&
    account.config.guestMode?.enabled === true &&
    account.config.guestMode.allowFrom?.some((id) => String(id) === String(from.id)) === true
  );
}

export function guestReplyText(text: string): string {
  const value = text.trim() || "This guest request produced no text response.";
  if (value.length <= 4096) {
    return value;
  }
  // Telegram's one-message limit; never split a surrogate pair or send chunks.
  const prefix = value.slice(0, 4095).replace(/[\uD800-\uDBFF]$/, "");
  return prefix + "…";
}

/** Guest capabilities stay in this transport closure, never in prompts or session metadata. */
export function registerTelegramGuestHandler(params: {
  bot: Bot<Context>;
  accountId: string;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}): { stop: () => void } {
  const controller = new AbortController();
  const { bot, accountId, runtime } = params;
  bot.on("guest_message", async (ctx) => {
    const message = ctx.guestMessage;
    const cfg = getTelegramRuntime().config.current({ clone: true });
    if (
      !isGuestCallerAllowed(cfg, accountId, message) ||
      !ctx.me.supports_guest_queries ||
      !message.guest_query_id ||
      !message.text?.trim() ||
      controller.signal.aborted ||
      params.abortSignal?.aborted ||
      Date.now() - message.date * 1000 > MAX_GUEST_REQUEST_AGE_MS
    ) {
      recordTelegramMessageProcessingResult({ kind: "skipped" });
      return;
    }
    const callerId = message.from!.id;
    // Each interaction is independent: neither ordinary history nor another guest
    // interaction can become context. Only account/channel bindings apply to this peer.
    const peerId = "guest:" + message.chat.id + ":" + callerId + ":" + ctx.update.update_id;
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId,
      peer: { kind: "group", id: peerId },
    });
    const lifecycle = getTelegramSpooledReplayLifecycle();
    const signal = AbortSignal.any([
      controller.signal,
      ...(params.abortSignal ? [params.abortSignal] : []),
      AbortSignal.timeout(GUEST_TURN_TIMEOUT_MS),
      ...(lifecycle ? [lifecycle.abortSignal] : []),
    ]);
    const body = message.text;
    const context = finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      From: "telegram:guest:" + callerId,
      To: "telegram:guest:" + message.chat.id,
      SessionKey: route.sessionKey,
      AccountId: accountId,
      ChatType: "group",
      Provider: "telegram",
      Surface: "telegram",
      SenderId: String(callerId),
      ConversationLabel: "Telegram guest interaction",
      MessageSid: String(ctx.update.update_id),
      CommandAuthorized: false,
      WasMentioned: true,
      GroupSystemPrompt:
        "This is a public Telegram guest reply. Answer only the current request. Do not reference personal memory or private conversations.",
    });
    let attempted = false;
    let sent = false;
    let failed = false;
    const suppressed = { visibleReplySent: false, suppression: { reason: "channel_transform" } };
    try {
      await dispatchReplyWithBufferedBlockDispatcher({
        cfg,
        ctx: context,
        replyOptions: {
          abortSignal: signal,
          disableTools: true,
          bootstrapContextMode: "lightweight",
          disableBlockStreaming: true,
          ...(lifecycle
            ? { turnAdoptionLifecycle: { ...lifecycle, admission: "exclusive" as const } }
            : {}),
        },
        dispatcherOptions: {
          deliver: async (payload, info) => {
            if (info.kind !== "final" || attempted) {
              return suppressed;
            }
            await info.onPlatformSendDispatch?.();
            const assertCurrent = () => {
              info.assertPlatformSendAuthorized?.();
              // The throttler repeats this check after queue/flood waits.
              const current = getTelegramRuntime().config.current({ clone: true });
              const currentRoute = resolveAgentRoute({
                cfg: current,
                channel: "telegram",
                accountId,
                peer: { kind: "group", id: peerId },
              });
              if (
                signal.aborted ||
                !isGuestCallerAllowed(current, accountId, message) ||
                currentRoute.agentId !== route.agentId
              ) {
                throw new Error("Telegram guest delivery authority is no longer current");
              }
            };
            // One logical attempt, inside dispatch so a receipt cannot claim success
            // before Telegram acknowledges it. No sendMessage fallback or ambiguous retry.
            attempted = true;
            // grammY uses abort-controller, while the agent runtime uses native signals.
            const apiController = new TelegramAbortController();
            const abortApi = () => apiController.abort();
            signal.addEventListener("abort", abortApi, { once: true });
            try {
              assertCurrent();
              const result = await runAuthorizedTelegramRequest(assertCurrent, () =>
                bot.api.answerGuestQuery(
                  message.guest_query_id!,
                  {
                    type: "article",
                    id: "guest-answer",
                    title: "Answer",
                    input_message_content: { message_text: guestReplyText(payload.text ?? "") },
                  },
                  apiController.signal,
                ),
              );
              sent = true;
              return result;
            } catch {
              // API errors may embed the query capability or foreign payload.
              failed = true;
              return { visibleReplySent: false, ambiguous: true };
            } finally {
              signal.removeEventListener("abort", abortApi);
            }
          },
          onError: () => {
            failed = true;
          },
        },
      });
    } catch {
      failed = true;
    }
    if (failed) {
      runtime.error?.("telegram guest request failed; no automatic answer retry was attempted");
    } else if (!sent) {
      runtime.log?.(
        "telegram guest reply intentionally not sent (cancelled, suppressed, or authority changed)",
      );
    }
    recordTelegramMessageProcessingResult({ kind: sent ? "completed" : "skipped" });
  });
  return { stop: () => controller.abort() };
}
