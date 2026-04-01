import {
  callGateway,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "openclaw/plugin-sdk/infra-runtime";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { decodeFeishuCardAction, buildFeishuCardActionTextFallback } from "./card-interaction.js";
import {
  createApprovalCard,
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";
import {
  isFeishuExecApprovalApprover,
  isFeishuExecApprovalClientEnabled,
} from "./exec-approvals.js";
import {
  FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION,
  FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION,
  FEISHU_EXEC_APPROVAL_DENY_ACTION,
  createExecApprovalResolvedCard,
} from "./card-ux-exec-approval.js";
import { sendCardFeishu, sendMessageFeishu, updateCardFeishu } from "./send.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id: string;
    user_id: string;
    chat_id: string;
    open_message_id?: string;
  };
};

const FEISHU_APPROVAL_CARD_TTL_MS = 5 * 60_000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60_000;
const processedCardActionTokens = new Map<
  string,
  { status: "inflight" | "completed"; expiresAt: number }
>();

export function resetProcessedFeishuCardActionTokensForTests(): void {
  processedCardActionTokens.clear();
}

function pruneProcessedCardActionTokens(now: number): void {
  for (const [key, entry] of processedCardActionTokens.entries()) {
    if (entry.expiresAt <= now) {
      processedCardActionTokens.delete(key);
    }
  }
}

function beginFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  pruneProcessedCardActionTokens(now);
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return true;
  }
  const key = `${params.accountId}:${normalizedToken}`;
  const existing = processedCardActionTokens.get(key);
  if (existing && existing.expiresAt > now) {
    return false;
  }
  processedCardActionTokens.set(key, {
    status: "inflight",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
  return true;
}

function completeFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.set(`${params.accountId}:${normalizedToken}`, {
    status: "completed",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
}

function releaseFeishuCardActionToken(params: { token: string; accountId: string }): void {
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.delete(`${params.accountId}:${normalizedToken}`);
}

function buildSyntheticMessageEvent(
  event: FeishuCardActionEvent,
  content: string,
  chatType?: "p2p" | "group",
): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: chatType ?? (event.context.chat_id ? "group" : "p2p"),
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };
}

function resolveCallbackTarget(event: FeishuCardActionEvent): string {
  const chatId = event.context.chat_id?.trim();
  if (chatId) {
    return `chat:${chatId}`;
  }
  return `user:${event.operator.open_id}`;
}

async function dispatchSyntheticCommand(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  command: string;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  chatType?: "p2p" | "group";
}): Promise<void> {
  await handleFeishuMessage({
    cfg: params.cfg,
    event: buildSyntheticMessageEvent(params.event, params.command, params.chatType),
    botOpenId: params.botOpenId,
    runtime: params.runtime,
    accountId: params.accountId,
  });
}

async function sendInvalidInteractionNotice(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  reason: "malformed" | "stale" | "wrong_user" | "wrong_conversation";
  accountId?: string;
}): Promise<void> {
  const reasonText =
    params.reason === "stale"
      ? "This card action has expired. Open a fresh launcher card and try again."
      : params.reason === "wrong_user"
        ? "This card action belongs to a different user."
        : params.reason === "wrong_conversation"
          ? "This card action belongs to a different conversation."
          : "This card action payload is invalid.";

  await sendMessageFeishu({
    cfg: params.cfg,
    to: resolveCallbackTarget(params.event),
    text: `⚠️ ${reasonText}`,
    accountId: params.accountId,
  });
}

function resolveExecApprovalDecision(
  action: string,
): "allow-once" | "allow-always" | "deny" | null {
  if (action === FEISHU_EXEC_APPROVAL_ALLOW_ONCE_ACTION) {
    return "allow-once";
  }
  if (action === FEISHU_EXEC_APPROVAL_ALLOW_ALWAYS_ACTION) {
    return "allow-always";
  }
  if (action === FEISHU_EXEC_APPROVAL_DENY_ACTION) {
    return "deny";
  }
  return null;
}

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const decoded = decodeFeishuCardAction({ event });
  const claimedToken = beginFeishuCardActionToken({
    token: event.token,
    accountId: account.accountId,
  });
  if (!claimedToken) {
    log(`feishu[${account.accountId}]: skipping duplicate card action token ${event.token}`);
    return;
  }

  try {
    if (decoded.kind === "invalid") {
      log(
        `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: ${decoded.reason}`,
      );
      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: decoded.reason,
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    if (decoded.kind === "structured") {
      const { envelope } = decoded;
      log(
        `feishu[${account.accountId}]: handling structured card action ${envelope.a} from ${event.operator.open_id}`,
      );

      if (envelope.a === FEISHU_APPROVAL_REQUEST_ACTION) {
        const command = typeof envelope.m?.command === "string" ? envelope.m.command.trim() : "";
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        const prompt =
          typeof envelope.m?.prompt === "string" && envelope.m.prompt.trim()
            ? envelope.m.prompt
            : `Run \`${command}\` in this Feishu conversation?`;
        await sendCardFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          card: createApprovalCard({
            operatorOpenId: event.operator.open_id,
            chatId: event.context.chat_id || undefined,
            command,
            prompt,
            sessionKey: envelope.c?.s,
            expiresAt: Date.now() + FEISHU_APPROVAL_CARD_TTL_MS,
            chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
            confirmLabel: command === "/reset" ? "Reset" : "Confirm",
          }),
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CANCEL_ACTION) {
        await sendMessageFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          text: "Cancelled.",
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CONFIRM_ACTION || envelope.k === "quick") {
        const command = envelope.q?.trim();
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        await dispatchSyntheticCommand({
          cfg,
          event,
          command,
          botOpenId: params.botOpenId,
          runtime,
          accountId,
          chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      const execApprovalDecision = resolveExecApprovalDecision(envelope.a);
      if (execApprovalDecision) {
        const approvalId =
          typeof envelope.m?.approvalId === "string" ? envelope.m.approvalId.trim() : "";
        if (!approvalId) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        // Verify exec approvals are still enabled for this account.
        if (!isFeishuExecApprovalClientEnabled({ cfg, accountId: account.accountId })) {
          await sendMessageFeishu({
            cfg,
            to: resolveCallbackTarget(event),
            text: "❌ 飞书命令执行审批已禁用。",
            accountId,
          }).catch(() => {});
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }

        // Verify the operator is a configured approver before resolving.
        if (
          !isFeishuExecApprovalApprover({
            cfg,
            accountId: account.accountId,
            senderId: event.operator.open_id,
          })
        ) {
          await sendMessageFeishu({
            cfg,
            to: resolveCallbackTarget(event),
            text: "❌ 你没有审批权限。",
            accountId,
          }).catch(() => {});
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }

        log(
          `feishu[${account.accountId}]: exec approval ${execApprovalDecision} for ${approvalId} by ${event.operator.open_id}`,
        );
        try {
          // Resolve the exec approval directly via gateway RPC instead of
          // dispatching a synthetic /approve chat command.  This avoids
          // the command reply and system notification messages.
          const resolvedBy = `feishu:${event.operator.open_id}`;
          await callGateway({
            method: "exec.approval.resolve",
            params: { id: approvalId, decision: execApprovalDecision },
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            clientDisplayName: `Feishu card approval (${resolvedBy})`,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          });
          // Update original card in-place if message ID is available,
          // otherwise fall back to sending a new card.
          const command =
            typeof envelope.m?.command === "string" ? envelope.m.command.trim() : undefined;
          const cwd = typeof envelope.m?.cwd === "string" ? envelope.m.cwd.trim() : undefined;
          const resolvedCard = createExecApprovalResolvedCard({
            approvalId,
            decision: execApprovalDecision,
            resolvedBy: event.operator.open_id,
            command: command || undefined,
            cwd: cwd || undefined,
          });
          const originalMessageId = event.context.open_message_id;
          let cardUpdated = false;
          if (originalMessageId) {
            try {
              await updateCardFeishu({
                cfg,
                messageId: originalMessageId,
                card: resolvedCard,
                accountId,
              });
              cardUpdated = true;
            } catch (patchErr) {
              log(
                `feishu[${account.accountId}]: failed to patch card ${originalMessageId}: ${String(patchErr)}`,
              );
            }
          }
          if (!cardUpdated) {
            await sendCardFeishu({
              cfg,
              to: resolveCallbackTarget(event),
              card: resolvedCard,
              accountId,
            }).catch(() => {});
          }
        } catch (err) {
          // Notify the user about the failure
          const errorText = `❌ Failed to submit exec approval: ${String(err)}`;
          await sendMessageFeishu({
            cfg,
            to: resolveCallbackTarget(event),
            text: errorText,
            accountId,
          }).catch(() => {});
        }
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: "malformed",
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    const content = buildFeishuCardActionTextFallback(event);

    log(
      `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
    );

    await dispatchSyntheticCommand({
      cfg,
      event,
      command: content,
      botOpenId: params.botOpenId,
      runtime,
      accountId,
    });
    completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
  } catch (err) {
    releaseFeishuCardActionToken({ token: event.token, accountId: account.accountId });
    throw err;
  }
}
