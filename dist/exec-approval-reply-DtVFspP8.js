import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { E as resolveExecApprovalAllowedDecisions } from "./exec-approvals-Bef7TPVc.js";
import { t as formatHumanList } from "./human-list-BmpwDy18.js";
import { t as formatApprovalDisplayPath } from "./approval-display-paths-BqRczx-P.js";
import { i as supportsNativeExecApprovalClient, n as listNativeExecApprovalClientLabels, t as describeNativeExecApprovalClientSetup } from "./exec-approval-surface-CsyFP7mh.js";
//#region src/infra/exec-approval-reply.ts
function resolveNativeExecApprovalClientList(params) {
	return formatHumanList(listNativeExecApprovalClientLabels({ excludeChannel: params?.excludeChannel }));
}
function buildGenericNativeExecApprovalFallbackText(params) {
	const clients = resolveNativeExecApprovalClientList({ excludeChannel: params?.excludeChannel });
	return clients ? `Approve it from the Web UI or terminal UI, or enable a native chat approval client such as ${clients}. If those accounts already know your owner ID via allowFrom or owner config, OpenClaw can often infer approvers automatically.` : "Approve it from the Web UI or terminal UI.";
}
function resolveAllowedDecisions(params) {
	return params.allowedDecisions ?? resolveExecApprovalAllowedDecisions({ ask: params.ask });
}
function buildApprovalCommandFence(descriptors) {
	if (descriptors.length === 0) return null;
	return buildFence(descriptors.map((descriptor) => descriptor.command).join("\n"), "txt");
}
function buildExecApprovalCommandText(params) {
	return `/approve ${params.approvalCommandId} ${params.decision}`;
}
function buildExecApprovalActionDescriptors(params) {
	const approvalCommandId = params.approvalCommandId.trim();
	if (!approvalCommandId) return [];
	const allowedDecisions = resolveAllowedDecisions(params);
	const descriptors = [];
	if (allowedDecisions.includes("allow-once")) descriptors.push({
		decision: "allow-once",
		label: "Allow Once",
		style: "success",
		command: buildExecApprovalCommandText({
			approvalCommandId,
			decision: "allow-once"
		})
	});
	if (allowedDecisions.includes("allow-always")) descriptors.push({
		decision: "allow-always",
		label: "Allow Always",
		style: "primary",
		command: buildExecApprovalCommandText({
			approvalCommandId,
			decision: "allow-always"
		})
	});
	if (allowedDecisions.includes("deny")) descriptors.push({
		decision: "deny",
		label: "Deny",
		style: "danger",
		command: buildExecApprovalCommandText({
			approvalCommandId,
			decision: "deny"
		})
	});
	return descriptors;
}
function buildApprovalInteractiveButtons(descriptors) {
	return descriptors.map((descriptor) => ({
		label: descriptor.label,
		value: descriptor.command,
		style: descriptor.style
	}));
}
function buildApprovalPresentationButtons(descriptors) {
	return descriptors.map((descriptor) => ({
		label: descriptor.label,
		value: descriptor.command,
		style: descriptor.style
	}));
}
/** Build the portable approval button presentation for already-resolved actions. */
function buildApprovalPresentationFromActionDescriptors(actions) {
	const buttons = buildApprovalPresentationButtons(actions);
	return buttons.length > 0 ? { blocks: [{
		type: "buttons",
		buttons
	}] } : void 0;
}
/** Build the portable approval presentation for an approval id and decision allowlist. */
function buildApprovalPresentation(params) {
	return buildApprovalPresentationFromActionDescriptors(buildExecApprovalActionDescriptors({
		approvalCommandId: params.approvalId,
		ask: params.ask,
		allowedDecisions: params.allowedDecisions
	}));
}
/** Build the portable exec-approval presentation for command callback buttons. */
function buildExecApprovalPresentation(params) {
	return buildApprovalPresentation({
		approvalId: params.approvalCommandId,
		ask: params.ask,
		allowedDecisions: params.allowedDecisions
	});
}
/**
* @deprecated Use buildApprovalPresentationFromActionDescriptors.
*/
function buildApprovalInteractiveReplyFromActionDescriptors(actions) {
	const buttons = buildApprovalInteractiveButtons(actions);
	return buttons.length > 0 ? { blocks: [{
		type: "buttons",
		buttons
	}] } : void 0;
}
/**
* @deprecated Use buildApprovalPresentation.
*/
function buildApprovalInteractiveReply(params) {
	return buildApprovalInteractiveReplyFromActionDescriptors(buildExecApprovalActionDescriptors({
		approvalCommandId: params.approvalId,
		ask: params.ask,
		allowedDecisions: params.allowedDecisions
	}));
}
/**
* @deprecated Use buildExecApprovalPresentation.
*/
function buildExecApprovalInteractiveReply(params) {
	return buildApprovalInteractiveReply({
		approvalId: params.approvalCommandId,
		ask: params.ask,
		allowedDecisions: params.allowedDecisions
	});
}
function getExecApprovalApproverDmNoticeText() {
	return "Approval required. I sent approval DMs to the approvers for this account.";
}
function parseExecApprovalCommandText(raw) {
	const match = raw.trim().match(/^\/?approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i);
	if (!match) return null;
	const rawDecision = normalizeOptionalLowercaseString(match[2]) ?? "";
	return {
		approvalId: match[1],
		decision: rawDecision === "always" ? "allow-always" : rawDecision
	};
}
function formatExecApprovalExpiresIn(expiresAtMs, nowMs) {
	const totalSeconds = Math.max(0, Math.round((expiresAtMs - nowMs) / 1e3));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	const seconds = totalSeconds % 60;
	const parts = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (hours === 0 && minutes < 5 && seconds > 0) parts.push(`${seconds}s`);
	return parts.join(" ");
}
function buildFence(text, language) {
	let fence = "```";
	while (text.includes(fence)) fence += "`";
	return `${fence}${language ? language : ""}\n${text}\n${fence}`;
}
function getExecApprovalReplyMetadata(payload) {
	const channelData = payload.channelData;
	if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) return null;
	const execApproval = channelData.execApproval;
	if (!execApproval || typeof execApproval !== "object" || Array.isArray(execApproval)) return null;
	const record = execApproval;
	const approvalId = normalizeOptionalString(record.approvalId) ?? "";
	const approvalSlug = normalizeOptionalString(record.approvalSlug) ?? "";
	if (!approvalId || !approvalSlug) return null;
	const approvalKind = record.approvalKind === "plugin" ? "plugin" : "exec";
	const allowedDecisions = Array.isArray(record.allowedDecisions) ? record.allowedDecisions.filter((value) => value === "allow-once" || value === "allow-always" || value === "deny") : void 0;
	return {
		approvalId,
		approvalSlug,
		approvalKind,
		agentId: normalizeOptionalString(record.agentId),
		allowedDecisions,
		sessionKey: normalizeOptionalString(record.sessionKey)
	};
}
function buildExecApprovalPendingReplyPayload(params) {
	const approvalCommandId = params.approvalCommandId?.trim() || params.approvalSlug;
	const allowedDecisions = resolveAllowedDecisions(params);
	const descriptors = buildExecApprovalActionDescriptors({
		approvalCommandId,
		allowedDecisions
	});
	const primaryAction = descriptors[0] ?? null;
	const secondaryActions = descriptors.slice(1);
	const lines = [];
	const warningText = params.warningText?.trim();
	if (warningText) lines.push(warningText);
	lines.push("Approval required.");
	if (primaryAction) {
		lines.push("Run:");
		lines.push(buildFence(primaryAction.command, "txt"));
	}
	lines.push("Pending command:");
	lines.push(buildFence(params.command, "sh"));
	const secondaryFence = buildApprovalCommandFence(secondaryActions);
	if (secondaryFence) {
		lines.push("Other options:");
		lines.push(secondaryFence);
	}
	if (!allowedDecisions.includes("allow-always")) lines.push("The effective approval policy requires approval every time, so Allow Always is unavailable.");
	const info = [];
	info.push(`Host: ${params.host}`);
	if (params.nodeId) info.push(`Node: ${params.nodeId}`);
	if (params.cwd) info.push(`CWD: ${formatApprovalDisplayPath(params.cwd)}`);
	if (typeof params.expiresAtMs === "number" && Number.isFinite(params.expiresAtMs)) info.push(`Expires in: ${formatExecApprovalExpiresIn(params.expiresAtMs, params.nowMs ?? Date.now())}`);
	info.push(`Full id: \`${params.approvalId}\``);
	lines.push(info.join("\n"));
	return {
		text: lines.join("\n\n"),
		presentation: buildApprovalPresentation({
			approvalId: params.approvalId,
			allowedDecisions
		}),
		channelData: { execApproval: {
			approvalId: params.approvalId,
			approvalSlug: params.approvalSlug,
			approvalKind: "exec",
			agentId: normalizeOptionalString(params.agentId),
			allowedDecisions,
			sessionKey: normalizeOptionalString(params.sessionKey)
		} }
	};
}
function buildExecApprovalUnavailableReplyPayload(params) {
	const lines = [];
	const warningText = params.warningText?.trim();
	if (warningText) lines.push(warningText);
	if (params.sentApproverDms) {
		lines.push(getExecApprovalApproverDmNoticeText());
		return { text: lines.join("\n\n") };
	}
	if (params.reason === "initiating-platform-disabled") {
		lines.push(`Exec approval is required, but native chat exec approvals are not configured on ${params.channelLabel ?? "this platform"}.`);
		const channel = normalizeOptionalLowercaseString(params.channel);
		const setupText = channel && params.channelLabel && supportsNativeExecApprovalClient(channel) ? describeNativeExecApprovalClientSetup({
			channel,
			channelLabel: params.channelLabel,
			accountId: params.accountId
		}) : null;
		if (setupText) lines.push(setupText);
		else lines.push(buildGenericNativeExecApprovalFallbackText());
	} else if (params.reason === "initiating-platform-unsupported") {
		lines.push(`Exec approval is required, but ${params.channelLabel ?? "this platform"} does not support chat exec approvals.`);
		lines.push(buildGenericNativeExecApprovalFallbackText({ excludeChannel: params.channel }));
	} else {
		lines.push("Exec approval is required, but no interactive approval client is currently available.");
		lines.push(`${buildGenericNativeExecApprovalFallbackText()} Then retry the command. You can usually leave execApprovals.approvers unset when owner config already identifies the approvers.`);
	}
	return { text: lines.join("\n\n") };
}
//#endregion
export { buildExecApprovalActionDescriptors as a, buildExecApprovalPendingReplyPayload as c, formatExecApprovalExpiresIn as d, getExecApprovalApproverDmNoticeText as f, buildApprovalPresentationFromActionDescriptors as i, buildExecApprovalPresentation as l, parseExecApprovalCommandText as m, buildApprovalInteractiveReplyFromActionDescriptors as n, buildExecApprovalCommandText as o, getExecApprovalReplyMetadata as p, buildApprovalPresentation as r, buildExecApprovalInteractiveReply as s, buildApprovalInteractiveReply as t, buildExecApprovalUnavailableReplyPayload as u };
