/**
 * Telegram approval handler — processes inline button callbacks for
 * trade approval/rejection.
 *
 * Registers an HTTP route that the Telegram webhook/bot framework can
 * call when a user clicks an inline button. This bridges Telegram
 * callback_query events to the AgentEventSqliteStore approve/reject flow.
 *
 * ARCH_LIMITATION: OpenClaw does not expose a plugin-level hook for
 * Telegram callback_query events. This module provides an HTTP endpoint
 * that must be triggered externally (via Telegram webhook or a bot
 * polling bridge). A future OpenClaw version could add a
 * "telegram_callback_query" plugin hook to make this seamless.
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { editMessageTelegram } from "../../../../src/telegram/send.js";
import type { HttpReq, HttpRes } from "../types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "../types-http.js";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";

// ── Types ──

export type TelegramCallbackPayload = {
  /** callback_data from the inline button, e.g. "fin_approve:evt-3-abc" */
  callbackData: string;
  /** Telegram chat_id where the button message was sent */
  chatId: string;
  /** Telegram message_id of the message with buttons */
  messageId: number;
  /** Optional rejection reason */
  reason?: string;
};

export type ApprovalResult = {
  ok: boolean;
  action: "approve" | "reject";
  eventId: string;
  error?: string;
};

// ── Parse callback data ──

export function parseCallbackData(
  callbackData: string,
): { action: "approve" | "reject"; eventId: string } | null {
  const approveMatch = /^fin_approve:(.+)$/.exec(callbackData);
  if (approveMatch) {
    return { action: "approve", eventId: approveMatch[1]! };
  }
  const rejectMatch = /^fin_reject:(.+)$/.exec(callbackData);
  if (rejectMatch) {
    return { action: "reject", eventId: rejectMatch[1]! };
  }
  return null;
}

// ── Process approval ──

export async function processApproval(
  eventStore: AgentEventSqliteStore,
  payload: TelegramCallbackPayload,
  opts?: { telegramBotToken?: string },
): Promise<ApprovalResult> {
  const parsed = parseCallbackData(payload.callbackData);
  if (!parsed) {
    return { ok: false, action: "approve", eventId: "", error: "Invalid callback data" };
  }

  const { action, eventId } = parsed;

  // Execute approve or reject on the event store
  let event;
  if (action === "approve") {
    event = eventStore.approve(eventId);
  } else {
    event = eventStore.reject(eventId, payload.reason);
  }

  if (!event) {
    return {
      ok: false,
      action,
      eventId,
      error: `Event ${eventId} not found or not in pending status`,
    };
  }

  // Update the original Telegram message to reflect the decision
  const statusEmoji = action === "approve" ? "\u2705" : "\u274c";
  const statusText = action === "approve" ? "APPROVED" : "REJECTED";
  const updatedText = `${statusEmoji} <b>[${statusText}]</b> ${event.title}\n\n${event.detail}\n\n<i>Decision: ${statusText} at ${new Date().toLocaleString("en-US", { timeZone: "UTC", hour12: false })}</i>`;

  try {
    await editMessageTelegram(payload.chatId, payload.messageId, updatedText, {
      token: opts?.telegramBotToken,
      textMode: "html",
      buttons: [], // Remove inline buttons after decision
    });
  } catch {
    // Best-effort: approval succeeded even if message edit fails
  }

  return { ok: true, action, eventId };
}

// ── HTTP Route Registration ──

type LifecycleEngineLike = {
  handleApproval(strategyId: string): boolean;
  handleRejection(strategyId: string, reason?: string): boolean;
};

export function registerTelegramApprovalRoute(
  api: OpenClawPluginApi,
  eventStore: AgentEventSqliteStore,
  opts?: {
    telegramBotToken?: string;
    lifecycleEngineResolver?: () => LifecycleEngineLike | undefined;
  },
): void {
  // POST /api/v1/finance/telegram/callback — handle Telegram inline button callbacks
  api.registerHttpRoute({
    path: "/api/v1/finance/telegram/callback",
    handler: async (req: unknown, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req as HttpReq);

        const callbackData = body.callbackData ?? body.callback_data;
        const chatId = body.chatId ?? body.chat_id;
        const messageId = body.messageId ?? body.message_id;

        if (typeof callbackData !== "string" || !callbackData) {
          errorResponse(res, 400, "callbackData is required");
          return;
        }
        if (!chatId) {
          errorResponse(res, 400, "chatId is required");
          return;
        }
        if (typeof messageId !== "number" || !Number.isFinite(messageId)) {
          errorResponse(res, 400, "messageId (number) is required");
          return;
        }

        const result = await processApproval(
          eventStore,
          {
            callbackData: callbackData as string,
            chatId: String(chatId),
            messageId: messageId as number,
            reason: typeof body.reason === "string" ? body.reason : undefined,
          },
          opts,
        );

        // Bridge to LifecycleEngine for L3 promotion approvals
        if (result.ok && opts?.lifecycleEngineResolver) {
          const event = eventStore.getEvent(result.eventId);
          if (event?.actionParams?.action === "promote_l3") {
            const engine = opts.lifecycleEngineResolver();
            const strategyId = event.actionParams.strategyId as string;
            if (engine && strategyId) {
              if (result.action === "approve") {
                engine.handleApproval(strategyId);
              } else {
                engine.handleRejection(
                  strategyId,
                  typeof body.reason === "string" ? body.reason : undefined,
                );
              }
            }
          }
        }

        jsonResponse(res, result.ok ? 200 : 404, result);
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // GET /api/v1/finance/notifications/stats — notification router stats endpoint
  // (registered here since the notification router is co-located with approval)
}
