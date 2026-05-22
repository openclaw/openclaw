import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { n as logError } from "./logger-M-PaInRe.js";
import { t as buildChannelApprovalNativeTargetKey } from "./approval-native-target-key-CyTY0lqh.js";
import "./text-runtime-FOsx_CPC.js";
import { n as buildApprovalInteractiveReplyFromActionDescriptors } from "./exec-approval-reply-DSHDyUW1.js";
import { r as createChannelApprovalNativeRuntimeAdapter } from "./approval-handler-runtime-C_rcrHYv.js";
import "./approval-handler-runtime-Bm-PqCwA.js";
import "./approval-native-runtime-B50UAOT8.js";
import "./approval-reply-runtime-DD8sKE86.js";
import { a as normalizeSlackApproverId, i as isSlackExecApprovalClientEnabled, s as shouldHandleSlackExecApprovalRequest } from "./exec-approvals-CYBrfQwr.js";
import { i as truncateSlackText } from "./thread-ts-DhEg7c-_.js";
import { t as resolveSlackReplyBlocks } from "./reply-blocks-DH4I3AwX.js";
import { t as sendMessageSlack } from "./send-WsETjS0b.js";
//#region extensions/slack/src/approval-handler.runtime.ts
const SLACK_CONTEXT_ELEMENTS_MAX = 10;
const SLACK_CHAT_UPDATE_TEXT_LIMIT = 4e3;
const SLACK_TEXT_OBJECT_MAX = 3e3;
function resolveHandlerContext(params) {
	const context = params.context;
	const accountId = normalizeOptionalString(params.accountId) ?? "";
	if (!context?.app || !accountId) return null;
	return {
		accountId,
		context
	};
}
function truncateSlackMrkdwn(text, maxChars) {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
function buildSlackCodeBlock(text) {
	let fence = "```";
	while (text.includes(fence)) fence += "`";
	return `${fence}\n${text}\n${fence}`;
}
function formatSlackApprover(resolvedBy) {
	const normalized = resolvedBy ? normalizeSlackApproverId(resolvedBy) : void 0;
	if (normalized) return `<@${normalized}>`;
	const trimmed = normalizeOptionalString(resolvedBy);
	return trimmed ? trimmed : null;
}
function formatSlackMetadataLine(label, value) {
	return `*${label}:* ${value}`;
}
function buildSlackMetadataLines(metadata) {
	return metadata.map((item) => formatSlackMetadataLine(item.label, item.value));
}
function buildSlackMetadataContextElements(metadata) {
	const lines = buildSlackMetadataLines(metadata);
	return (lines.length > SLACK_CONTEXT_ELEMENTS_MAX ? [...lines.slice(0, SLACK_CONTEXT_ELEMENTS_MAX - 1), `…+${lines.length - (SLACK_CONTEXT_ELEMENTS_MAX - 1)} more`] : lines).map((line) => ({
		type: "mrkdwn",
		text: truncateSlackMrkdwn(line, SLACK_TEXT_OBJECT_MAX)
	}));
}
function resolveSlackApprovalDecisionLabel(decision) {
	return decision === "allow-once" ? "Allowed once" : decision === "allow-always" ? "Allowed always" : "Denied";
}
function buildSlackPendingApprovalText(view) {
	const metadataLines = buildSlackMetadataLines(view.metadata);
	return [
		"*Exec approval required*",
		"A command needs your approval.",
		"",
		"*Command*",
		buildSlackCodeBlock(view.commandText),
		...metadataLines
	].filter(Boolean).join("\n");
}
function buildSlackPendingApprovalBlocks(view) {
	const metadataElements = buildSlackMetadataContextElements(view.metadata);
	const interactiveBlocks = resolveSlackReplyBlocks({
		text: "",
		interactive: buildApprovalInteractiveReplyFromActionDescriptors(view.actions)
	}) ?? [];
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "*Exec approval required*\nA command needs your approval."
			}
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`
			}
		},
		...metadataElements.length > 0 ? [{
			type: "context",
			elements: metadataElements
		}] : [],
		...interactiveBlocks
	];
}
function buildSlackResolvedText(view) {
	const resolvedBy = formatSlackApprover(view.resolvedBy);
	return [
		`*Exec approval: ${resolveSlackApprovalDecisionLabel(view.decision)}*`,
		resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved.",
		"",
		"*Command*",
		buildSlackCodeBlock(view.commandText)
	].join("\n");
}
function buildSlackResolvedBlocks(view) {
	const resolvedBy = formatSlackApprover(view.resolvedBy);
	return [{
		type: "section",
		text: {
			type: "mrkdwn",
			text: `*Exec approval: ${resolveSlackApprovalDecisionLabel(view.decision)}*\n${resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved."}`
		}
	}, {
		type: "section",
		text: {
			type: "mrkdwn",
			text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`
		}
	}];
}
function buildSlackExpiredText(view) {
	return [
		"*Exec approval expired*",
		"This approval request expired before it was resolved.",
		"",
		"*Command*",
		buildSlackCodeBlock(view.commandText)
	].join("\n");
}
function buildSlackExpiredBlocks(view) {
	return [{
		type: "section",
		text: {
			type: "mrkdwn",
			text: "*Exec approval expired*\nThis approval request expired before it was resolved."
		}
	}, {
		type: "section",
		text: {
			type: "mrkdwn",
			text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`
		}
	}];
}
async function updateMessage(params) {
	try {
		await params.app.client.chat.update({
			channel: params.channelId,
			ts: params.messageTs,
			text: truncateSlackText(params.text, SLACK_CHAT_UPDATE_TEXT_LIMIT),
			blocks: params.blocks
		});
	} catch (err) {
		logError(`slack exec approvals: failed to update message: ${String(err)}`);
	}
}
const slackApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter({
	eventKinds: ["exec"],
	availability: {
		isConfigured: (params) => {
			const resolved = resolveHandlerContext(params);
			return resolved ? isSlackExecApprovalClientEnabled({
				cfg: params.cfg,
				accountId: resolved.accountId
			}) : false;
		},
		shouldHandle: (params) => {
			const resolved = resolveHandlerContext(params);
			if (!resolved) return false;
			return shouldHandleSlackExecApprovalRequest({
				cfg: params.cfg,
				accountId: resolved.accountId,
				request: params.request
			});
		}
	},
	presentation: {
		buildPendingPayload: ({ view }) => ({
			text: buildSlackPendingApprovalText(view),
			blocks: buildSlackPendingApprovalBlocks(view)
		}),
		buildResolvedResult: ({ view }) => ({
			kind: "update",
			payload: {
				text: buildSlackResolvedText(view),
				blocks: buildSlackResolvedBlocks(view)
			}
		}),
		buildExpiredResult: ({ view }) => ({
			kind: "update",
			payload: {
				text: buildSlackExpiredText(view),
				blocks: buildSlackExpiredBlocks(view)
			}
		})
	},
	transport: {
		prepareTarget: ({ plannedTarget }) => ({
			dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
			target: {
				to: plannedTarget.target.to,
				threadTs: plannedTarget.target.threadId != null ? String(plannedTarget.target.threadId) : void 0
			}
		}),
		deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
			const resolved = resolveHandlerContext({
				cfg,
				accountId,
				context
			});
			if (!resolved) return null;
			const message = await sendMessageSlack(preparedTarget.to, pendingPayload.text, {
				cfg,
				accountId: resolved.accountId,
				threadTs: preparedTarget.threadTs,
				blocks: pendingPayload.blocks,
				client: resolved.context.app.client
			});
			return {
				channelId: message.channelId,
				messageTs: message.messageId
			};
		},
		updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
			const resolved = resolveHandlerContext({
				cfg,
				accountId,
				context
			});
			if (!resolved) return;
			const nextPayload = payload;
			await updateMessage({
				app: resolved.context.app,
				channelId: entry.channelId,
				messageTs: entry.messageTs,
				text: nextPayload.text,
				blocks: nextPayload.blocks
			});
		}
	},
	observe: { onDeliveryError: ({ error, request }) => {
		logError(`slack exec approvals: failed to deliver approval ${request.id}: ${String(error)}`);
	} }
});
//#endregion
export { slackApprovalNativeRuntime };
