import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as createSubsystemLogger } from "./subsystem-D1_uRCZT.js";
import "./text-runtime-icMZVCaq.js";
import { t as buildChannelApprovalNativeTargetKey } from "./approval-native-target-key-B2IQmEkC.js";
import "./runtime-env-BBcuHj0d.js";
import { n as buildApprovalInteractiveReplyFromActionDescriptors, o as buildExecApprovalPendingReplyPayload } from "./exec-approval-reply-ABF0LE59.js";
import { r as createChannelApprovalNativeRuntimeAdapter } from "./approval-handler-runtime-DC2q4ahe.js";
import "./approval-handler-runtime-YVYGD5lk.js";
import "./approval-native-runtime-DtQT5-vL.js";
import { r as buildPluginApprovalPendingReplyPayload } from "./approval-renderers-D1XUKxoe.js";
import "./approval-reply-runtime-CC5M2Scd.js";
import { i as editMessageReplyMarkupTelegram, p as sendTypingTelegram, u as sendMessageTelegram } from "./send-z8ZBu6_X.js";
import { a as isTelegramExecApprovalHandlerConfigured, u as shouldHandleTelegramExecApprovalRequest } from "./exec-approvals-rE6Fe75E.js";
import { t as resolveTelegramInlineButtons } from "./button-types-Dn4Mznj4.js";
//#region extensions/telegram/src/approval-handler.runtime.ts
const log = createSubsystemLogger("telegram/approvals");
function resolveHandlerContext(params) {
	const context = params.context;
	const accountId = normalizeOptionalString(params.accountId) ?? "";
	if (!context?.token || !accountId) return null;
	return {
		accountId,
		context
	};
}
function buildPendingPayload(params) {
	return {
		text: (params.approvalKind === "plugin" ? buildPluginApprovalPendingReplyPayload({
			request: params.request,
			nowMs: params.nowMs
		}) : buildExecApprovalPendingReplyPayload({
			approvalId: params.request.id,
			approvalSlug: params.request.id.slice(0, 8),
			approvalCommandId: params.request.id,
			warningText: params.view.approvalKind === "exec" ? params.view.warningText ?? void 0 : void 0,
			command: params.view.approvalKind === "exec" ? params.view.commandText : "",
			cwd: params.view.approvalKind === "exec" ? params.view.cwd ?? void 0 : void 0,
			host: params.view.approvalKind === "exec" && params.view.host === "node" ? "node" : "gateway",
			nodeId: params.view.approvalKind === "exec" ? params.view.nodeId ?? void 0 : void 0,
			allowedDecisions: params.view.actions.map((action) => action.decision),
			expiresAtMs: params.request.expiresAtMs,
			nowMs: params.nowMs
		})).text ?? "",
		buttons: resolveTelegramInlineButtons({ interactive: buildApprovalInteractiveReplyFromActionDescriptors(params.view.actions) })
	};
}
const telegramApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter({
	eventKinds: ["exec", "plugin"],
	availability: {
		isConfigured: (params) => {
			const resolved = resolveHandlerContext(params);
			return resolved ? isTelegramExecApprovalHandlerConfigured({
				cfg: params.cfg,
				accountId: resolved.accountId
			}) : false;
		},
		shouldHandle: (params) => {
			const resolved = resolveHandlerContext(params);
			return resolved ? shouldHandleTelegramExecApprovalRequest({
				cfg: params.cfg,
				accountId: resolved.accountId,
				request: params.request
			}) : false;
		}
	},
	presentation: {
		buildPendingPayload: ({ request, approvalKind, nowMs, view }) => buildPendingPayload({
			request,
			approvalKind,
			nowMs,
			view
		}),
		buildResolvedResult: () => ({ kind: "clear-actions" }),
		buildExpiredResult: () => ({ kind: "clear-actions" })
	},
	transport: {
		prepareTarget: ({ plannedTarget }) => ({
			dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
			target: {
				chatId: plannedTarget.target.to,
				messageThreadId: typeof plannedTarget.target.threadId === "number" ? plannedTarget.target.threadId : void 0
			}
		}),
		deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
			const resolved = resolveHandlerContext({
				cfg,
				accountId,
				context
			});
			if (!resolved) return null;
			const sendTyping = resolved.context.deps?.sendTyping ?? sendTypingTelegram;
			const sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;
			await sendTyping(preparedTarget.chatId, {
				cfg,
				token: resolved.context.token,
				accountId: resolved.accountId,
				...preparedTarget.messageThreadId != null ? { messageThreadId: preparedTarget.messageThreadId } : {}
			}).catch(() => {});
			const result = await sendMessage(preparedTarget.chatId, pendingPayload.text, {
				cfg,
				token: resolved.context.token,
				accountId: resolved.accountId,
				buttons: pendingPayload.buttons,
				...preparedTarget.messageThreadId != null ? { messageThreadId: preparedTarget.messageThreadId } : {}
			});
			return {
				chatId: result.chatId,
				messageId: result.messageId
			};
		}
	},
	interactions: { clearPendingActions: async ({ cfg, accountId, context, entry }) => {
		const resolved = resolveHandlerContext({
			cfg,
			accountId,
			context
		});
		if (!resolved) return;
		await (resolved.context.deps?.editReplyMarkup ?? editMessageReplyMarkupTelegram)(entry.chatId, entry.messageId, [], {
			cfg,
			token: resolved.context.token,
			accountId: resolved.accountId
		});
	} },
	observe: { onDeliveryError: ({ error, request }) => {
		log.error(`telegram approvals: failed to send request ${request.id}: ${String(error)}`);
	} }
});
//#endregion
export { telegramApprovalNativeRuntime };
