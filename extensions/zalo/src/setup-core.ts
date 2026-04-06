import {
  addWildcardAllowFrom,
  createDelegatedSetupWizardProxy,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";

const channel = "zalo" as const;

export const zaloSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError: "ZALO_BOT_TOKEN can only be used for the default account.",
    whenNotUseEnv: [
      {
        someOf: ["token", "tokenFile"],
        message: "Zalo requires token or --token-file (or --use-env).",
      },
    ],
  }),
  buildPatch: (input) =>
    input.useEnv
      ? {}
      : input.tokenFile
        ? { tokenFile: input.tokenFile }
        : input.token
          ? { botToken: input.token }
          : {},
});

export const zaloDmPolicy: ChannelSetupDmPolicy = {
  label: "Zalo",
  channel,
  policyKey: "channels.zalo.dmPolicy",
  allowFromKey: "channels.zalo.allowFrom",
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultZaloAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.zalo.accounts.${accountId ?? resolveDefaultZaloAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.zalo.accounts.${accountId ?? resolveDefaultZaloAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.zalo.dmPolicy",
          allowFromKey: "channels.zalo.allowFrom",
        },
  getCurrent: (cfg, accountId) =>
    resolveZaloAccount({
      cfg: cfg,
      accountId: accountId ?? resolveDefaultZaloAccountId(cfg),
    }).config.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultZaloAccountId(cfg);
    const resolved = resolveZaloAccount({
      cfg: cfg,
      accountId: resolvedAccountId,
    });
    if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zalo: {
            ...cfg.channels?.zalo,
            enabled: true,
            dmPolicy: policy,
            ...(policy === "open"
              ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) }
              : {}),
          },
        },
      };
    }
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: true,
          accounts: {
            ...cfg.channels?.zalo?.accounts,
            [resolvedAccountId]: {
              ...cfg.channels?.zalo?.accounts?.[resolvedAccountId],
              enabled: cfg.channels?.zalo?.accounts?.[resolvedAccountId]?.enabled ?? true,
              dmPolicy: policy,
              ...(policy === "open"
                ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) }
                : {}),
            },
          },
        },
      },
    };
  },
  promptAllowFrom: async (params) =>
    (await loadZaloSetupWizard()).dmPolicy?.promptAllowFrom?.(params) ?? params.cfg,
};

async function loadZaloSetupWizard(): Promise<ChannelSetupWizard> {
  return (await import("./setup-surface.js")).zaloSetupWizard;
}

export function createZaloSetupWizardProxy(
  loadWizard: () => Promise<ChannelSetupWizard>,
): ChannelSetupWizard {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: "configured",
      unconfiguredLabel: "needs token",
      configuredHint: "recommended · configured",
      unconfiguredHint: "recommended · newcomer-friendly",
      configuredScore: 1,
      unconfiguredScore: 10,
    },
    credentials: [],
    delegateFinalize: true,
    dmPolicy: zaloDmPolicy,
    disable: (cfg) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: false,
        },
      },
    }),
  });
}
