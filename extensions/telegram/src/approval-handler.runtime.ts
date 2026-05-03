import type {
  ChannelApprovalCapabilityHandlerContext,
  ChannelApprovalKind,
  PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { buildPluginApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalPendingReplyParams,
  type ExecApprovalRequest,
  type PluginApprovalRequest,
} from "openclaw/plugin-sdk/infra-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  bindTelegramApprovalReply,
  unbindTelegramApprovalReply,
  type TelegramApprovalReplyBinding,
} from "./approval-reply-bindings.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import {
  isTelegramExecApprovalHandlerConfigured,
  shouldHandleTelegramExecApprovalRequest,
} from "./exec-approvals.js";
import { editMessageReplyMarkupTelegram, sendMessageTelegram, sendTypingTelegram } from "./send.js";

const log = createSubsystemLogger("telegram/approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type PendingMessage = {
  chatId: string;
  messageId: string;
};
type TelegramPendingDelivery = {
  text: string;
  buttons: ReturnType<typeof resolveTelegramInlineButtons>;
};

export type TelegramExecApprovalHandlerDeps = {
  nowMs?: () => number;
  sendTyping?: typeof sendTypingTelegram;
  sendMessage?: typeof sendMessageTelegram;
  editReplyMarkup?: typeof editMessageReplyMarkupTelegram;
};

export type TelegramApprovalHandlerContext = {
  token: string;
  deps?: TelegramExecApprovalHandlerDeps;
};

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: TelegramApprovalHandlerContext;
} | null {
  const context = params.context as TelegramApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.token || !accountId) {
    return null;
  }
  return { accountId, context };
}

function buildPendingPayload(params: {
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): TelegramPendingDelivery {
  const approvalCommandId = params.request.id.slice(0, 8);
  const execAllowedDecisions =
    params.approvalKind === "exec"
      ? params.view.actions.length > 0
        ? params.view.actions.map((action) => action.decision)
        : resolveExecApprovalRequestAllowedDecisions(
            (params.request as ExecApprovalRequest).request,
          )
      : [];
  const payload =
    params.approvalKind === "plugin"
      ? buildPluginApprovalPendingReplyPayload({
          request: params.request as PluginApprovalRequest,
          nowMs: params.nowMs,
        })
      : buildExecApprovalPendingReplyPayload({
          approvalId: params.request.id,
          approvalSlug: approvalCommandId,
          approvalCommandId,
          command: params.view.approvalKind === "exec" ? params.view.commandText : "",
          cwd: params.view.approvalKind === "exec" ? (params.view.cwd ?? undefined) : undefined,
          host:
            params.view.approvalKind === "exec" && params.view.host === "node" ? "node" : "gateway",
          nodeId:
            params.view.approvalKind === "exec" ? (params.view.nodeId ?? undefined) : undefined,
          allowedDecisions: execAllowedDecisions,
          expiresAtMs: params.request.expiresAtMs,
          nowMs: params.nowMs,
        } satisfies ExecApprovalPendingReplyParams);
  return {
    text: payload.text ?? "",
    buttons: resolveTelegramInlineButtons({
      interactive: payload.interactive,
    }),
  };
}

function resolveReplyBindingAllowedDecisions(params: {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  view: PendingApprovalView;
}) {
  if (params.view.actions.length > 0) {
    return params.view.actions.map((action) => action.decision);
  }
  return params.approvalKind === "exec"
    ? resolveExecApprovalRequestAllowedDecisions((params.request as ExecApprovalRequest).request)
    : [];
}

export const telegramApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  TelegramPendingDelivery,
  { chatId: string; messageThreadId?: number },
  PendingMessage,
  TelegramApprovalReplyBinding
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isTelegramExecApprovalHandlerConfigured({
            cfg: params.cfg,
            accountId: resolved.accountId,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? shouldHandleTelegramExecApprovalRequest({
            cfg: params.cfg,
            accountId: resolved.accountId,
            request: params.request,
          })
        : false;
    },
  },
  presentation: {
    buildPendingPayload: ({ request, approvalKind, nowMs, view }) =>
      buildPendingPayload({ request, approvalKind, nowMs, view }),
    buildResolvedResult: () => ({ kind: "clear-actions" }),
    buildExpiredResult: () => ({ kind: "clear-actions" }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
      target: {
        chatId: plannedTarget.target.to,
        messageThreadId:
          typeof plannedTarget.target.threadId === "number"
            ? plannedTarget.target.threadId
            : undefined,
      },
    }),
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const sendTyping = resolved.context.deps?.sendTyping ?? sendTypingTelegram;
      const sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;
      await sendTyping(preparedTarget.chatId, {
        cfg,
        token: resolved.context.token,
        accountId: resolved.accountId,
        ...(preparedTarget.messageThreadId != null
          ? { messageThreadId: preparedTarget.messageThreadId }
          : {}),
      }).catch(() => {});
      const result = await sendMessage(preparedTarget.chatId, pendingPayload.text, {
        cfg,
        token: resolved.context.token,
        accountId: resolved.accountId,
        buttons: pendingPayload.buttons,
        ...(preparedTarget.messageThreadId != null
          ? { messageThreadId: preparedTarget.messageThreadId }
          : {}),
      });
      return {
        chatId: result.chatId,
        messageId: result.messageId,
      };
    },
  },
  interactions: {
    bindPending: ({ accountId, entry, request, approvalKind, view }) => {
      const resolvedAccountId = normalizeOptionalString(accountId);
      if (!resolvedAccountId) {
        return null;
      }
      return bindTelegramApprovalReply({
        accountId: resolvedAccountId,
        chatId: entry.chatId,
        messageId: entry.messageId,
        approvalId: request.id,
        approvalKind,
        createdAtMs: request.createdAtMs,
        expiresAtMs: view.expiresAtMs,
        allowedDecisions: resolveReplyBindingAllowedDecisions({ request, approvalKind, view }),
        commandText: view.approvalKind === "exec" ? view.commandText : null,
      });
    },
    unbindPending: ({ binding }) => {
      unbindTelegramApprovalReply(binding);
    },
    clearPendingActions: async ({ cfg, accountId, context, entry }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const editReplyMarkup =
        resolved.context.deps?.editReplyMarkup ?? editMessageReplyMarkupTelegram;
      await editReplyMarkup(entry.chatId, entry.messageId, [], {
        cfg,
        token: resolved.context.token,
        accountId: resolved.accountId,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`telegram approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
