import {
	createResolvedApproverActionAuthAdapter,
	resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { parseSlackTarget } from "./targets.js";

function normalizeSlackApproverId(value: string | number): string | undefined {
	const trimmed = String(value).trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const target = parseSlackTarget(trimmed, { defaultKind: "user" });
		return target?.kind === "user" ? target.id : undefined;
	} catch {
		return /^[A-Z0-9]+$/i.test(trimmed) ? trimmed : undefined;
	}
}

export const slackApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Slack",
	resolveApprovers: ({ cfg, accountId }) => {
		const account = resolveSlackAccount({ cfg, accountId }).config;
		return resolveApprovalApprovers({
			allowFrom: account.allowFrom,
			extraAllowFrom: account.dm?.allowFrom,
			defaultTo: account.defaultTo,
			normalizeApprover: normalizeSlackApproverId,
		});
	},
	normalizeSenderId: (value) => normalizeSlackApproverId(value),
});
