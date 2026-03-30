import {
	type ChannelSetupAdapter,
	type ChannelSetupInput,
	type ChannelSetupWizard,
	createSetupInputPresenceValidator,
	DEFAULT_ACCOUNT_ID,
	formatDocsLink,
	normalizeAccountId,
	type OpenClawConfig,
	patchScopedAccountConfig,
	prepareScopedSetupConfig,
} from "openclaw/plugin-sdk/setup";
import { buildTlonAccountFields } from "./account-fields.js";
import { normalizeShip } from "./targets.js";
import {
	listTlonAccountIds,
	resolveTlonAccount,
	type TlonResolvedAccount,
} from "./types.js";
import { validateUrbitBaseUrl } from "./urbit/base-url.js";

function tlonChannelId() {
	return "tlon" as const;
}

export type TlonSetupInput = ChannelSetupInput & {
	ship?: string;
	url?: string;
	code?: string;
	allowPrivateNetwork?: boolean;
	groupChannels?: string[];
	dmAllowlist?: string[];
	autoDiscoverChannels?: boolean;
	ownerShip?: string;
};

function isConfigured(account: TlonResolvedAccount): boolean {
	return Boolean(account.ship && account.url && account.code);
}

type TlonSetupWizardBaseParams = {
	resolveConfigured: (params: {
		cfg: OpenClawConfig;
	}) => boolean | Promise<boolean>;
	resolveStatusLines?: (params: {
		cfg: OpenClawConfig;
		configured: boolean;
	}) => string[] | Promise<string[]>;
	finalize: NonNullable<ChannelSetupWizard["finalize"]>;
};

export function createTlonSetupWizardBase(
	params: TlonSetupWizardBaseParams,
): ChannelSetupWizard {
	return {
		channel: tlonChannelId(),
		status: {
			configuredLabel: "configured",
			unconfiguredLabel: "needs setup",
			configuredHint: "configured",
			unconfiguredHint: "urbit messenger",
			configuredScore: 1,
			unconfiguredScore: 4,
			resolveConfigured: ({ cfg }) => params.resolveConfigured({ cfg }),
			resolveStatusLines: ({ cfg, configured }) =>
				params.resolveStatusLines?.({ cfg, configured }) ?? [],
		},
		introNote: {
			title: "Tlon setup",
			lines: [
				"You need your Urbit ship URL and login code.",
				"Example URL: https://your-ship-host",
				"Example ship: ~sampel-palnet",
				"If your ship URL is on a private network (LAN/localhost), you must explicitly allow it during setup.",
				`Docs: ${formatDocsLink("/channels/tlon", "channels/tlon")}`,
			],
		},
		credentials: [],
		textInputs: [
			{
				inputKey: "ship",
				message: "Ship name",
				placeholder: "~sampel-palnet",
				currentValue: ({ cfg, accountId }) =>
					resolveTlonAccount(cfg, accountId).ship ?? undefined,
				validate: ({ value }) =>
					String(value ?? "").trim() ? undefined : "Required",
				normalizeValue: ({ value }) => normalizeShip(String(value).trim()),
				applySet: async ({ cfg, accountId, value }) =>
					applyTlonSetupConfig({
						cfg,
						accountId,
						input: { ship: value },
					}),
			},
			{
				inputKey: "url",
				message: "Ship URL",
				placeholder: "https://your-ship-host",
				currentValue: ({ cfg, accountId }) =>
					resolveTlonAccount(cfg, accountId).url ?? undefined,
				validate: ({ value }) => {
					const next = validateUrbitBaseUrl(String(value ?? ""));
					if (!next.ok) {
						return next.error;
					}
					return undefined;
				},
				normalizeValue: ({ value }) => String(value).trim(),
				applySet: async ({ cfg, accountId, value }) =>
					applyTlonSetupConfig({
						cfg,
						accountId,
						input: { url: value },
					}),
			},
			{
				inputKey: "code",
				message: "Login code",
				placeholder: "lidlut-tabwed-pillex-ridrup",
				currentValue: ({ cfg, accountId }) =>
					resolveTlonAccount(cfg, accountId).code ?? undefined,
				validate: ({ value }) =>
					String(value ?? "").trim() ? undefined : "Required",
				normalizeValue: ({ value }) => String(value).trim(),
				applySet: async ({ cfg, accountId, value }) =>
					applyTlonSetupConfig({
						cfg,
						accountId,
						input: { code: value },
					}),
			},
		],
		finalize: params.finalize,
	};
}

export async function resolveTlonSetupConfigured(
	cfg: OpenClawConfig,
): Promise<boolean> {
	const accountIds = listTlonAccountIds(cfg);
	return accountIds.length > 0
		? accountIds.some((accountId) =>
				isConfigured(resolveTlonAccount(cfg, accountId)),
			)
		: isConfigured(resolveTlonAccount(cfg, DEFAULT_ACCOUNT_ID));
}

export async function resolveTlonSetupStatusLines(
	cfg: OpenClawConfig,
): Promise<string[]> {
	const configured = await resolveTlonSetupConfigured(cfg);
	return [`Tlon: ${configured ? "configured" : "needs setup"}`];
}

export function applyTlonSetupConfig(params: {
	cfg: OpenClawConfig;
	accountId: string;
	input: TlonSetupInput;
}): OpenClawConfig {
	const { cfg, accountId, input } = params;
	const useDefault = accountId === DEFAULT_ACCOUNT_ID;
	const namedConfig = prepareScopedSetupConfig({
		cfg,
		channelKey: tlonChannelId(),
		accountId,
		name: input.name,
	});
	const base = namedConfig.channels?.tlon ?? {};
	const payload = buildTlonAccountFields(input);

	if (useDefault) {
		return {
			...namedConfig,
			channels: {
				...namedConfig.channels,
				tlon: {
					...base,
					enabled: true,
					...payload,
				},
			},
		};
	}

	return patchScopedAccountConfig({
		cfg: namedConfig,
		channelKey: tlonChannelId(),
		accountId,
		patch: { enabled: base.enabled ?? true },
		accountPatch: {
			enabled: true,
			...payload,
		},
		ensureChannelEnabled: false,
		ensureAccountEnabled: false,
	});
}

export const tlonSetupAdapter: ChannelSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) =>
		prepareScopedSetupConfig({
			cfg,
			channelKey: tlonChannelId(),
			accountId,
			name,
		}),
	validateInput: createSetupInputPresenceValidator({
		validate: ({ cfg, accountId, input }) => {
			const resolved = resolveTlonAccount(cfg, accountId ?? undefined);
			const ship = input.ship?.trim() || resolved.ship;
			const url = input.url?.trim() || resolved.url;
			const code = input.code?.trim() || resolved.code;
			if (!ship) {
				return "Tlon requires --ship.";
			}
			if (!url) {
				return "Tlon requires --url.";
			}
			if (!code) {
				return "Tlon requires --code.";
			}
			return null;
		},
	}),
	applyAccountConfig: ({ cfg, accountId, input }) =>
		applyTlonSetupConfig({
			cfg,
			accountId,
			input: input as TlonSetupInput,
		}),
};
