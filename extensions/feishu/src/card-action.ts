import { execSync } from "child_process";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import { resolveFeishuAccount } from "./accounts.js";

/**
 * Feishu card action callback event payload.
 * Delivered as `card.action.trigger` via EventDispatcher.
 */
export interface FeishuCardActionEvent {
  operator: {
    tenant_key: string;
    user_id: string;
    open_id: string;
    union_id?: string;
  };
  action: {
    value: Record<string, unknown>;
    tag: string;
    option?: string;
    /** For date_picker / picker actions */
    timezone?: string;
  };
  host: string;
  context: {
    open_message_id: string;
    open_chat_id: string;
  };
  /** Additional fields from the event envelope */
  token?: string;
  event_type?: string;
}

/**
 * Card action callback response.
 * Return this to update the card and/or show a toast.
 * @see https://open.larkoffice.com/document/feishu-cards/card-callback-communication
 */
export interface CardActionResponse {
  toast?: {
    type: "info" | "success" | "warning" | "error";
    content: string;
    i18n?: Record<string, string>;
  };
  card?: {
    type: "raw";
    data: Record<string, unknown>;
  };
}

export interface HandleCardActionParams {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  runtime?: RuntimeEnv;
  accountId: string;
}

/**
 * Handle a Feishu card action callback.
 *
 * 1. Emits a system event so the agent is notified of the action.
 * 2. If `cardActionHandler` is configured, invokes the external script
 *    synchronously to produce a callback response (card update + toast).
 *
 * The handler script receives the event payload as a base64-encoded JSON
 * argument and must print a JSON response to stdout.
 */
export async function handleFeishuCardAction(
  params: HandleCardActionParams,
): Promise<CardActionResponse | undefined> {
  const { cfg, event, runtime, accountId } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const operatorId = event.operator?.open_id ?? "unknown";
  const messageId = event.context?.open_message_id ?? "unknown";
  const chatId = event.context?.open_chat_id ?? "unknown";
  const actionValue = event.action?.value;

  log(
    `feishu[${accountId}]: card action from ${operatorId} on message ${messageId}: ${JSON.stringify(actionValue)}`,
  );

  // Emit system event so the agent sees the card action
  try {
    const core = getFeishuRuntime();
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu",
      accountId,
      peer: {
        kind: "direct",
        id: operatorId,
      },
    });

    const actionSummary = JSON.stringify(actionValue);
    core.system.enqueueSystemEvent(
      `Feishu[${accountId}] card action from ${operatorId} on message ${messageId}: ${actionSummary}`,
      {
        sessionKey: route.sessionKey,
        contextKey: `feishu:card_action:${chatId}:${messageId}`,
      },
    );
  } catch (err) {
    error(`feishu[${accountId}]: failed to emit card action system event: ${String(err)}`);
  }

  // If a card action handler script is configured, invoke it synchronously
  const feishuCfg = cfg.channels?.feishu as Record<string, unknown> | undefined;
  const handlerPath = feishuCfg?.cardActionHandler as string | undefined;

  if (handlerPath) {
    try {
      const b64 = Buffer.from(JSON.stringify(event)).toString("base64");
      const result = execSync(`node "${handlerPath}" "${b64}"`, {
        timeout: 15_000,
        encoding: "utf-8",
        env: { ...process.env },
      }).trim();

      if (result) {
        const parsed = JSON.parse(result) as CardActionResponse;
        log(`feishu[${accountId}]: card action handler returned response`);
        return parsed;
      }
    } catch (err) {
      error(`feishu[${accountId}]: card action handler error: ${String(err)}`);
    }
  }

  return undefined;
}
