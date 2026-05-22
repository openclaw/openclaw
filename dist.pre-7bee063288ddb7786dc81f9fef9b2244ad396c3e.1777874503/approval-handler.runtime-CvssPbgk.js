import { t as buildChannelApprovalNativeTargetKey } from "./approval-native-target-key-B2IQmEkC.js";
import { o as buildExecApprovalPendingReplyPayload } from "./exec-approval-reply-ABF0LE59.js";
import { r as createChannelApprovalNativeRuntimeAdapter } from "./approval-handler-runtime-DC2q4ahe.js";
import "./approval-handler-runtime-YVYGD5lk.js";
import "./approval-native-runtime-DtQT5-vL.js";
import { i as buildPluginApprovalResolvedReplyPayload, r as buildPluginApprovalPendingReplyPayload } from "./approval-renderers-D1XUKxoe.js";
import "./approval-reply-runtime-CC5M2Scd.js";
import "./approval-runtime-DSdfw78x.js";
import { a as resolveMatrixTargetIdentity } from "./target-ids-0j2eTstQ.js";
import { i as resolveMatrixAccount } from "./accounts-9iJQ7pUi.js";
import { c as shouldHandleMatrixApprovalRequest, r as isMatrixAnyApprovalClientEnabled } from "./exec-approvals-Dx3w9Kk8.js";
import { a as sendMessageMatrix, c as sendSingleTextMessageMatrix, i as reactMatrixMessage } from "./send-B79nWc0r.js";
import { i as repairMatrixDirectRooms } from "./direct-management-Bm9uwHNh.js";
import { a as unregisterMatrixApprovalReactionTarget, n as listMatrixApprovalReactionBindings, r as registerMatrixApprovalReactionTarget, t as buildMatrixApprovalReactionHint } from "./approval-reactions-IdOxO0gt.js";
import { n as editMatrixMessage, t as deleteMatrixMessage } from "./messages-BJLlK42G.js";
//#region extensions/matrix/src/approval-handler.runtime.ts
const MATRIX_APPROVAL_METADATA_KEY = "com.openclaw.approval";
function resolveHandlerContext(params) {
	const context = params.context;
	const accountId = params.accountId?.trim() || "";
	if (!context?.client || !accountId) return null;
	return {
		accountId,
		context
	};
}
function normalizePendingMessageIds(entry) {
	return Array.from(new Set(entry.messageIds.map((messageId) => messageId.trim()).filter(Boolean)));
}
function normalizeReactionTargetRef(params) {
	const roomId = params.roomId.trim();
	const eventId = params.eventId.trim();
	if (!roomId || !eventId) return null;
	return {
		roomId,
		eventId
	};
}
function normalizeThreadId(value) {
	return (value == null ? "" : String(value).trim()) || void 0;
}
function isSingleMatrixMessageLimitError(error) {
	return error instanceof Error && error.message.includes("Matrix single-message text exceeds limit");
}
async function prepareTarget(params) {
	const resolved = resolveHandlerContext(params);
	if (!resolved) return null;
	const target = resolveMatrixTargetIdentity(params.rawTarget.to);
	if (!target) return null;
	const threadId = normalizeThreadId(params.rawTarget.threadId);
	if (target.kind === "user") {
		const account = resolveMatrixAccount({
			cfg: params.cfg,
			accountId: resolved.accountId
		});
		const repaired = await (resolved.context.deps?.repairDirectRooms ?? repairMatrixDirectRooms)({
			client: resolved.context.client,
			remoteUserId: target.id,
			encrypted: account.config.encryption === true
		});
		if (!repaired.activeRoomId) return null;
		return {
			to: `room:${repaired.activeRoomId}`,
			roomId: repaired.activeRoomId,
			threadId
		};
	}
	return {
		to: `room:${target.id}`,
		roomId: target.id,
		threadId
	};
}
function buildMatrixApprovalMetadata(params) {
	const base = {
		version: 1,
		type: "approval.request",
		id: params.view.approvalId,
		state: "pending",
		kind: params.view.approvalKind,
		phase: params.view.phase,
		title: params.view.title,
		expiresAtMs: params.view.expiresAtMs,
		metadata: params.view.metadata,
		allowedDecisions: Array.from(params.allowedDecisions),
		actions: params.view.actions.map((action) => ({
			decision: action.decision,
			label: action.label,
			style: action.style,
			command: action.command
		})),
		...params.view.description != null ? { description: params.view.description } : {}
	};
	if (params.view.approvalKind === "plugin") return {
		...base,
		kind: "plugin",
		severity: params.view.severity,
		...params.view.agentId != null ? { agentId: params.view.agentId } : {},
		...params.view.pluginId != null ? { pluginId: params.view.pluginId } : {},
		...params.view.toolName != null ? { toolName: params.view.toolName } : {}
	};
	return {
		...base,
		kind: "exec",
		commandText: params.view.commandText,
		...params.view.ask != null ? { ask: params.view.ask } : {},
		...params.view.agentId != null ? { agentId: params.view.agentId } : {},
		...params.view.commandPreview != null ? { commandPreview: params.view.commandPreview } : {},
		...params.view.cwd != null ? { cwd: params.view.cwd } : {},
		...params.view.envKeys != null ? { envKeys: params.view.envKeys } : {},
		...params.view.host != null ? { host: params.view.host } : {},
		...params.view.nodeId != null ? { nodeId: params.view.nodeId } : {},
		...params.view.sessionKey != null ? { sessionKey: params.view.sessionKey } : {}
	};
}
function buildPendingApprovalContent(params) {
	const allowedDecisions = params.view.actions.map((action) => action.decision);
	const payload = params.view.approvalKind === "plugin" ? buildPluginApprovalPendingReplyPayload({
		request: {
			id: params.view.approvalId,
			request: {
				title: params.view.title,
				description: params.view.description ?? "",
				severity: params.view.severity,
				toolName: params.view.toolName ?? void 0,
				pluginId: params.view.pluginId ?? void 0,
				agentId: params.view.agentId ?? void 0
			},
			createdAtMs: 0,
			expiresAtMs: params.view.expiresAtMs
		},
		nowMs: params.nowMs,
		allowedDecisions
	}) : buildExecApprovalPendingReplyPayload({
		approvalId: params.view.approvalId,
		approvalSlug: params.view.approvalId.slice(0, 8),
		approvalCommandId: params.view.approvalId,
		ask: params.view.ask ?? void 0,
		agentId: params.view.agentId ?? void 0,
		allowedDecisions,
		command: params.view.commandText,
		cwd: params.view.cwd ?? void 0,
		host: params.view.host === "node" ? "node" : "gateway",
		nodeId: params.view.nodeId ?? void 0,
		sessionKey: params.view.sessionKey ?? void 0,
		expiresAtMs: params.view.expiresAtMs,
		nowMs: params.nowMs
	});
	const hint = buildMatrixApprovalReactionHint(allowedDecisions);
	const text = payload.text ?? "";
	return {
		approvalId: params.view.approvalId,
		text: hint ? text ? `${hint}\n\n${text}` : hint : text,
		allowedDecisions,
		extraContent: { [MATRIX_APPROVAL_METADATA_KEY]: buildMatrixApprovalMetadata({
			view: params.view,
			allowedDecisions
		}) }
	};
}
function buildResolvedApprovalText(view) {
	if (view.approvalKind === "plugin") return buildPluginApprovalResolvedReplyPayload({ resolved: {
		id: view.approvalId,
		decision: view.decision,
		resolvedBy: view.resolvedBy ?? void 0,
		ts: 0
	} }).text ?? "";
	return [
		`Exec approval: ${view.decision === "allow-once" ? "Allowed once" : view.decision === "allow-always" ? "Allowed always" : "Denied"}`,
		"",
		"Command",
		buildMarkdownCodeBlock(view.commandText)
	].join("\n");
}
function buildMarkdownCodeBlock(text) {
	const longestFence = Math.max(...Array.from(text.matchAll(/`+/g), (match) => match[0].length), 0);
	const fence = "`".repeat(Math.max(3, longestFence + 1));
	return [
		fence,
		text,
		fence
	].join("\n");
}
const matrixApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter({
	eventKinds: ["exec", "plugin"],
	availability: {
		isConfigured: ({ cfg, accountId, context }) => {
			const resolved = resolveHandlerContext({
				cfg,
				accountId,
				context
			});
			if (!resolved) return false;
			return isMatrixAnyApprovalClientEnabled({
				cfg,
				accountId: resolved.accountId
			});
		},
		shouldHandle: ({ cfg, accountId, request, context }) => {
			const resolved = resolveHandlerContext({
				cfg,
				accountId,
				context
			});
			if (!resolved) return false;
			return shouldHandleMatrixApprovalRequest({
				cfg,
				accountId: resolved.accountId,
				request
			});
		}
	},
	presentation: {
		buildPendingPayload: ({ view, nowMs }) => buildPendingApprovalContent({
			view,
			nowMs
		}),
		buildResolvedResult: ({ view }) => ({
			kind: "update",
			payload: buildResolvedApprovalText(view)
		}),
		buildExpiredResult: () => ({ kind: "delete" })
	},
	transport: {
		prepareTarget: ({ cfg, accountId, context, plannedTarget }) => {
			return prepareTarget({
				cfg,
				accountId,
				context,
				rawTarget: plannedTarget.target
			}).then((preparedTarget) => preparedTarget ? {
				dedupeKey: buildChannelApprovalNativeTargetKey({
					to: preparedTarget.roomId,
					threadId: preparedTarget.threadId
				}),
				target: preparedTarget
			} : null);
		},
		deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
			const resolved = resolveHandlerContext({
				cfg,
				accountId,
				context
			});
			if (!resolved) return null;
			const sendSingleTextMessage = resolved.context.deps?.sendSingleTextMessage ?? sendSingleTextMessageMatrix;
			const reactMessage = resolved.context.deps?.reactMessage ?? reactMatrixMessage;
			let result;
			try {
				result = await sendSingleTextMessage(preparedTarget.to, pendingPayload.text, {
					cfg,
					accountId: resolved.accountId,
					client: resolved.context.client,
					threadId: preparedTarget.threadId,
					extraContent: pendingPayload.extraContent
				});
			} catch (error) {
				if (!isSingleMatrixMessageLimitError(error)) throw error;
				result = await (resolved.context.deps?.sendMessage ?? sendMessageMatrix)(preparedTarget.to, pendingPayload.text, {
					cfg,
					accountId: resolved.accountId,
					client: resolved.context.client,
					threadId: preparedTarget.threadId,
					extraContent: pendingPayload.extraContent
				});
			}
			const messageIds = Array.from(new Set((result.messageIds ?? [result.messageId]).map((messageId) => messageId.trim()).filter(Boolean)));
			const reactionEventId = result.primaryMessageId?.trim() || messageIds[0] || result.messageId.trim();
			await Promise.allSettled(listMatrixApprovalReactionBindings(pendingPayload.allowedDecisions).map(async ({ emoji }) => {
				await reactMessage(result.roomId, reactionEventId, emoji, {
					cfg,
					accountId: resolved.accountId,
					client: resolved.context.client
				});
			}));
			return {
				roomId: result.roomId,
				messageIds,
				reactionEventId
			};
		},
		updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
			const resolved = resolveHandlerContext({
				cfg,
				accountId,
				context
			});
			if (!resolved) return;
			const editMessage = resolved.context.deps?.editMessage ?? editMatrixMessage;
			const deleteMessage = resolved.context.deps?.deleteMessage ?? deleteMatrixMessage;
			const [primaryMessageId, ...staleMessageIds] = normalizePendingMessageIds(entry);
			if (!primaryMessageId) return;
			const text = payload;
			await Promise.allSettled([editMessage(entry.roomId, primaryMessageId, text, {
				cfg,
				accountId: resolved.accountId,
				client: resolved.context.client
			}), ...staleMessageIds.map(async (messageId) => {
				await deleteMessage(entry.roomId, messageId, {
					cfg,
					accountId: resolved.accountId,
					client: resolved.context.client,
					reason: "approval resolved"
				});
			})]);
		},
		deleteEntry: async ({ cfg, accountId, context, entry, phase }) => {
			const resolved = resolveHandlerContext({
				cfg,
				accountId,
				context
			});
			if (!resolved) return;
			const deleteMessage = resolved.context.deps?.deleteMessage ?? deleteMatrixMessage;
			await Promise.allSettled(normalizePendingMessageIds(entry).map(async (messageId) => {
				await deleteMessage(entry.roomId, messageId, {
					cfg,
					accountId: resolved.accountId,
					client: resolved.context.client,
					reason: phase === "expired" ? "approval expired" : "approval resolved"
				});
			}));
		}
	},
	interactions: {
		bindPending: ({ entry, pendingPayload }) => {
			const target = normalizeReactionTargetRef({
				roomId: entry.roomId,
				eventId: entry.reactionEventId
			});
			if (!target) return null;
			registerMatrixApprovalReactionTarget({
				roomId: target.roomId,
				eventId: target.eventId,
				approvalId: pendingPayload.approvalId,
				allowedDecisions: pendingPayload.allowedDecisions
			});
			return target;
		},
		unbindPending: ({ binding }) => {
			const target = normalizeReactionTargetRef(binding);
			if (!target) return;
			unregisterMatrixApprovalReactionTarget(target);
		}
	}
});
//#endregion
export { matrixApprovalNativeRuntime };
