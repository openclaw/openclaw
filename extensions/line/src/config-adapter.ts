import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import {
	listLineAccountIds,
	type OpenClawConfig,
	type ResolvedLineAccount,
	resolveDefaultLineAccountId,
	resolveLineAccount,
} from "../runtime-api.js";

export function normalizeLineAllowFrom(entry: string): string {
	return entry.replace(/^line:(?:user:)?/i, "");
}

export const lineConfigAdapter = createScopedChannelConfigAdapter<
	ResolvedLineAccount,
	ResolvedLineAccount,
	OpenClawConfig
>({
	sectionKey: "line",
	listAccountIds: listLineAccountIds,
	resolveAccount: (cfg, accountId) =>
		resolveLineAccount({ cfg, accountId: accountId ?? undefined }),
	defaultAccountId: resolveDefaultLineAccountId,
	clearBaseFields: ["channelSecret", "tokenFile", "secretFile"],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) =>
		allowFrom
			.map((entry) => String(entry).trim())
			.filter(Boolean)
			.map(normalizeLineAllowFrom),
});
