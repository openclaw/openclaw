import {
	createResolvedApproverActionAuthAdapter,
	resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import type { CoreConfig } from "./types.js";

function normalizeMatrixApproverId(value: string | number): string | undefined {
	const normalized = normalizeMatrixUserId(String(value));
	return normalized || undefined;
}

export const matrixApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Matrix",
	resolveApprovers: ({ cfg, accountId }) => {
		const account = resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId });
		return resolveApprovalApprovers({
			allowFrom: account.config.dm?.allowFrom,
			normalizeApprover: normalizeMatrixApproverId,
		});
	},
	normalizeSenderId: (value) => normalizeMatrixApproverId(value),
});
