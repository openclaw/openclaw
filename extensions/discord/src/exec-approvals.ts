import {
	getExecApprovalReplyMetadata,
	resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { parseDiscordTarget } from "./targets.js";

function normalizeDiscordApproverId(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	if (/^\d+$/.test(trimmed)) {
		return trimmed;
	}
	try {
		const target = parseDiscordTarget(trimmed);
		return target?.kind === "user" ? target.id : undefined;
	} catch {
		return undefined;
	}
}

export function getDiscordExecApprovalApprovers(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
}): string[] {
	const account = resolveDiscordAccount(params).config;
	return resolveApprovalApprovers({
		explicit: account.execApprovals?.approvers,
		allowFrom: account.allowFrom,
		extraAllowFrom: account.dm?.allowFrom,
		defaultTo: account.defaultTo,
		normalizeApprover: (value) => normalizeDiscordApproverId(String(value)),
		normalizeDefaultTo: (value) => {
			try {
				const target = parseDiscordTarget(value);
				return target?.kind === "user" ? target.id : undefined;
			} catch {
				return undefined;
			}
		},
	});
}

export function isDiscordExecApprovalClientEnabled(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
}): boolean {
	const config = resolveDiscordAccount(params).config.execApprovals;
	return Boolean(
		config?.enabled && getDiscordExecApprovalApprovers(params).length > 0,
	);
}

export function isDiscordExecApprovalApprover(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
	senderId?: string | null;
}): boolean {
	const senderId = params.senderId?.trim();
	if (!senderId) {
		return false;
	}
	return getDiscordExecApprovalApprovers(params).includes(senderId);
}

export function shouldSuppressLocalDiscordExecApprovalPrompt(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
	payload: ReplyPayload;
}): boolean {
	return (
		isDiscordExecApprovalClientEnabled(params) &&
		getExecApprovalReplyMetadata(params.payload) !== null
	);
}
