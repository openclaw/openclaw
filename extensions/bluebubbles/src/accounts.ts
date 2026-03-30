import {
	createAccountListHelpers,
	normalizeAccountId,
	resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
	hasConfiguredSecretInput,
	normalizeSecretInputString,
} from "./secret-input.js";
import {
	type BlueBubblesAccountConfig,
	normalizeBlueBubblesServerUrl,
} from "./types.js";

export type ResolvedBlueBubblesAccount = {
	accountId: string;
	enabled: boolean;
	name?: string;
	config: BlueBubblesAccountConfig;
	configured: boolean;
	baseUrl?: string;
};

const {
	listAccountIds: listBlueBubblesAccountIds,
	resolveDefaultAccountId: resolveDefaultBlueBubblesAccountId,
} = createAccountListHelpers("bluebubbles");
export { listBlueBubblesAccountIds, resolveDefaultBlueBubblesAccountId };

function mergeBlueBubblesAccountConfig(
	cfg: OpenClawConfig,
	accountId: string,
): BlueBubblesAccountConfig {
	const merged = resolveMergedAccountConfig<BlueBubblesAccountConfig>({
		channelConfig: cfg.channels?.bluebubbles as
			| BlueBubblesAccountConfig
			| undefined,
		accounts: cfg.channels?.bluebubbles?.accounts as
			| Record<string, Partial<BlueBubblesAccountConfig>>
			| undefined,
		accountId,
		omitKeys: ["defaultAccount"],
	});
	return { ...merged, chunkMode: merged.chunkMode ?? "length" };
}

export function resolveBlueBubblesAccount(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
}): ResolvedBlueBubblesAccount {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = params.cfg.channels?.bluebubbles?.enabled;
	const merged = mergeBlueBubblesAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const serverUrl = normalizeSecretInputString(merged.serverUrl);
	const _password = normalizeSecretInputString(merged.password);
	const configured = Boolean(
		serverUrl && hasConfiguredSecretInput(merged.password),
	);
	const baseUrl = serverUrl
		? normalizeBlueBubblesServerUrl(serverUrl)
		: undefined;
	return {
		accountId,
		enabled: baseEnabled !== false && accountEnabled,
		name: merged.name?.trim() || undefined,
		config: merged,
		configured,
		baseUrl,
	};
}

export function listEnabledBlueBubblesAccounts(
	cfg: OpenClawConfig,
): ResolvedBlueBubblesAccount[] {
	return listBlueBubblesAccountIds(cfg)
		.map((accountId) => resolveBlueBubblesAccount({ cfg, accountId }))
		.filter((account) => account.enabled);
}
