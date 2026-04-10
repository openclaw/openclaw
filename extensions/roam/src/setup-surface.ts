import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { setSetupChannelEnabled } from "openclaw/plugin-sdk/setup";
import { type ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup";
import { listRoamAccountIds, resolveRoamAccount } from "./accounts.js";
import {
  clearRoamAccountFields,
  roamDmPolicy,
  roamSetupAdapter,
  setRoamAccountConfig,
} from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const channel = "roam" as const;

export const roamSetupWizard: ChannelSetupWizard = {
  channel,
  stepOrder: "text-first",
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs setup",
    configuredHint: "configured",
    unconfiguredHint: "Roam HQ team messaging",
    configuredScore: 1,
    unconfiguredScore: 5,
    resolveConfigured: ({ cfg }) =>
      listRoamAccountIds(cfg as CoreConfig).some((accountId) => {
        const account = resolveRoamAccount({ cfg: cfg as CoreConfig, accountId });
        return Boolean(account.apiKey);
      }),
  },
  introNote: {
    title: "Roam HQ bot setup",
    lines: [
      "1) Go to Roam Administration > Developer",
      "2) Create a new API key for your bot",
      "3) Copy the API key",
      "Tip: you can also set ROAM_API_KEY in your env.",
      `Docs: ${formatDocsLink("/channels/roam", "channels/roam")}`,
    ],
    shouldShow: ({ cfg, accountId }) => {
      const account = resolveRoamAccount({ cfg: cfg as CoreConfig, accountId });
      return !account.apiKey;
    },
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "API key",
      preferredEnvVar: "ROAM_API_KEY",
      envPrompt: "ROAM_API_KEY detected. Use env var?",
      keepPrompt: "Roam API key already configured. Keep it?",
      inputPrompt: "Enter Roam API key",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolvedAccount = resolveRoamAccount({ cfg: cfg as CoreConfig, accountId });
        return {
          accountConfigured: Boolean(resolvedAccount.apiKey),
          hasConfiguredValue: Boolean(
            hasConfiguredSecretInput(resolvedAccount.config.apiKey) ||
            resolvedAccount.config.apiKeyFile,
          ),
          resolvedValue: resolvedAccount.apiKey || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.ROAM_API_KEY?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: async (params) => {
        const cleared = clearRoamAccountFields(params.cfg as CoreConfig, params.accountId, [
          "apiKey",
          "apiKeyFile",
        ]);
        return cleared;
      },
      applySet: async (params) =>
        setRoamAccountConfig(
          clearRoamAccountFields(params.cfg as CoreConfig, params.accountId, [
            "apiKey",
            "apiKeyFile",
          ]),
          params.accountId,
          { apiKey: params.value },
        ),
    },
  ],
  textInputs: [],
  dmPolicy: roamDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { roamSetupAdapter };
