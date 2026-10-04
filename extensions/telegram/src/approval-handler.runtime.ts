import type {
  ChannelApprovalCapabilityHandlerContext,
  ChannelApprovalKind,
  PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildPluginApprovalPendingReplyPayload,
  buildApprovalPresentationFromActionDescriptors,
  buildExecApprovalPendingReplyPayload,
  formatExecApprovalExpiresIn,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ExecApprovalPendingReplyParams } from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import { resolveGatewayPublicOrigin } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildTelegramApprovalCallbackData } from "./approval-callback-data.js";
import {
  buildTelegramNativeExpiredApprovalText,
  buildTelegramNativeResolvedApprovalText,
} from "./approval-terminal.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import {
  isTelegramExecApprovalHandlerConfigured,
  shouldHandleTelegramExecApprovalRequest,
} from "./exec-approvals.js";
import { escapeTelegramHtml } from "./format.js";
import {
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  sendMessageTelegram,
  sendTypingTelegram,
} from "./send.js";
import { normalizeTelegramChatId, parseTelegramTarget } from "./targets.js";

const log = createSubsystemLogger("telegram/approvals");
// Retain one origin notice across all terminal entries for an approval.
// The finalization observer releases it after fan-out; without this lifecycle bound, ids leak.
const terminalizedSystemAgentApprovals = new Set<string>();

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
type PendingMessage = {
  chatId: string;
  messageId: string;
};
type TelegramPendingDelivery = {
  text: string;
  buttons: ReturnType<typeof resolveTelegramInlineButtons>;
};
type TelegramFinalDelivery = {
  text: string;
};

type TelegramExecApprovalHandlerDeps = {
  sendTyping?: typeof sendTypingTelegram;
  sendMessage?: typeof sendMessageTelegram;
  editMessage?: typeof editMessageTelegram;
  editReplyMarkup?: typeof editMessageReplyMarkupTelegram;
};

type TelegramApprovalHandlerContext = {
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
  cfg: ChannelApprovalCapabilityHandlerContext["cfg"];
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  nowMs: number;
  view: PendingApprovalView;
}): TelegramPendingDelivery {
  if (params.approvalKind === "system-agent") {
    const view = params.view;
    if (view.approvalKind !== "system-agent") {
      throw new Error("system-agent approval request and view kinds do not match");
    }
    const origin = resolveGatewayPublicOrigin(params.cfg);
    const reviewUrl =
      origin && params.cfg.gateway?.controlUi?.enabled !== false
        ? `${origin}${normalizeTelegramControlUiBasePath(
            params.cfg.gateway?.controlUi?.basePath,
          )}/approve/${encodeURIComponent(params.request.id)}`
        : undefined;
    const lines = [
      "🔒 OpenClaw change requires approval",
      `Change: ${view.operationSummary}`,
      `Agent: ${view.agentId ?? "unknown"}`,
      `Expires in: ${formatExecApprovalExpiresIn(params.request.expiresAtMs, params.nowMs)}`,
    ];
    const decisionButtons = view.actions.flatMap((action) => {
      const approvalAction = action.action;
      if (!approvalAction || approvalAction.type !== "approval") {
        return [];
      }
      const callbackData = buildTelegramApprovalCallbackData(approvalAction);
      const style =
        action.style === "danger" || action.style === "success" || action.style === "primary"
          ? action.style
          : undefined;
      return callbackData
        ? [{ text: action.label, callback_data: callbackData, ...(style ? { style } : {}) }]
        : [];
    });
    return {
      text: lines.join("\n"),
      buttons: reviewUrl
        ? [
            [{ text: "Review in Control UI", url: reviewUrl }],
            ...(decisionButtons.length > 0 ? [decisionButtons] : []),
          ]
        : decisionButtons.length > 0
          ? [decisionButtons]
          : [],
    };
  }
  const execView = params.view.approvalKind === "exec" ? params.view : undefined;
  const payload =
    params.approvalKind === "plugin"
      ? buildPluginApprovalPendingReplyPayload({
          request: params.request as PluginApprovalRequest,
          nowMs: params.nowMs,
        })
      : buildExecApprovalPendingReplyPayload({
          approvalId: params.request.id,
          approvalSlug: params.request.id.slice(0, 8),
          approvalCommandId: params.request.id,
          warningText: execView?.warningText ?? undefined,
          command: execView?.commandText ?? "",
          cwd: execView?.cwd ?? undefined,
          host: execView?.host === "node" ? "node" : "gateway",
          nodeId: execView?.nodeId ?? undefined,
          scope: execView?.scope ?? undefined,
          allowedDecisions: params.view.actions.map((action) => action.decision),
          expiresAtMs: params.request.expiresAtMs,
          nowMs: params.nowMs,
        } satisfies ExecApprovalPendingReplyParams);
  return {
    text: payload.text ?? "",
    buttons: resolveTelegramInlineButtons({
      presentation: buildApprovalPresentationFromActionDescriptors(params.view.actions),
    }),
  };
}

export const telegramApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  TelegramPendingDelivery,
  { chatId: string; messageThreadId?: number; directMessagesTopicId?: number },
  PendingMessage,
  never,
  TelegramFinalDelivery
>({
  eventKinds: ["exec", "plugin", "system-agent"],
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
    buildPendingPayload,
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: { text: buildTelegramNativeResolvedApprovalText(view) },
    }),
    buildExpiredResult: ({ view }) => ({
      kind: "update",
      payload: { text: buildTelegramNativeExpiredApprovalText(view) },
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => {
      const parsedTarget = parseTelegramTarget(plannedTarget.target.to);
      return {
        dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
        target: {
          chatId: parsedTarget.chatId,
          messageThreadId:
            typeof plannedTarget.target.threadId === "number"
              ? plannedTarget.target.threadId
              : parsedTarget.messageThreadId,
          directMessagesTopicId: parsedTarget.directMessagesTopicId,
        },
      };
    },
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const sendTyping = resolved.context.deps?.sendTyping ?? sendTypingTelegram;
      const sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;
      const options = {
        cfg,
        token: resolved.context.token,
        accountId: resolved.accountId,
        ...(preparedTarget.messageThreadId != null
          ? { messageThreadId: preparedTarget.messageThreadId }
          : {}),
      };
      await sendTyping(preparedTarget.chatId, options).catch(() => {});
      const result = await sendMessage(preparedTarget.chatId, pendingPayload.text, {
        ...options,
        buttons: pendingPayload.buttons,
        ...(preparedTarget.directMessagesTopicId != null
          ? { directMessagesTopicId: preparedTarget.directMessagesTopicId }
          : {}),
      });
      return {
        chatId: result.chatId,
        messageId: result.messageId,
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload, request, approvalKind }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const editMessage = resolved.context.deps?.editMessage ?? editMessageTelegram;
      let editError: unknown;
      try {
        await editMessage(entry.chatId, entry.messageId, escapeTelegramHtml(payload.text), {
          cfg,
          token: resolved.context.token,
          accountId: resolved.accountId,
          textMode: "html",
          buttons: [],
        });
      } catch (error) {
        editError = error;
      }
      if (
        approvalKind === "system-agent" &&
        request.request.turnSourceChannel?.trim().toLowerCase() === "telegram"
      ) {
        const originTarget = request.request.turnSourceTo?.trim();
        const parsedOrigin = originTarget ? parseTelegramTarget(originTarget) : undefined;
        const originChatId = parsedOrigin
          ? normalizeTelegramChatId(parsedOrigin.chatId)
          : undefined;
        const originThreadId =
          parseStrictPositiveInteger(request.request.turnSourceThreadId) ??
          parsedOrigin?.messageThreadId;
        const sourceAccountId = request.request.turnSourceAccountId?.trim();
        const isSourceAccount = !sourceAccountId || sourceAccountId === resolved.accountId;
        if (
          originChatId &&
          isSourceAccount &&
          (entry.chatId !== originChatId || editError !== undefined)
        ) {
          if (!terminalizedSystemAgentApprovals.has(request.id)) {
            const sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;
            const originTo =
              parsedOrigin?.directMessagesTopicId != null ? originTarget! : originChatId;
            await sendMessage(originTo, escapeTelegramHtml(payload.text), {
              cfg,
              token: resolved.context.token,
              accountId: resolved.accountId,
              textMode: "html",
              ...(originThreadId != null ? { messageThreadId: originThreadId } : {}),
            });
            terminalizedSystemAgentApprovals.add(request.id);
          }
        } else if (originChatId && isSourceAccount) {
          terminalizedSystemAgentApprovals.add(request.id);
        }
      }
      if (editError !== undefined) {
        throw editError instanceof Error ? editError : new Error(formatErrorMessage(editError));
      }
    },
  },
  interactions: {
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
    onFinalized: ({ request, approvalKind }) => {
      if (approvalKind === "system-agent") {
        terminalizedSystemAgentApprovals.delete(request.id);
      }
    },
  },
});

function normalizeTelegramControlUiBasePath(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "/") {
    return "";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}
