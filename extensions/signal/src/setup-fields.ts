import {
  createCliPathTextInput,
  createSetupTranslator,
  DEFAULT_ACCOUNT_ID,
  mergeAllowFromEntries,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  type ChannelSetupWizardTextInput,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultSignalAccountId, resolveSignalAccount } from "./accounts.js";
import {
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  patchSignalSetupConfigForAccount,
  resolveSignalSetupTransportFromCredentialValues,
  SIGNAL_PHONE_NUMBER_EXAMPLE,
} from "./setup-config.js";

const t = createSetupTranslator();
const channel = "signal" as const;

async function promptSignalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: t("wizard.signal.allowlistTitle"),
    noteLines: [
      t("wizard.signal.allowlistIntro"),
      "Use phone numbers in international format, or uuid:... if Signal only exposes a sender UUID.",
      "Use * only if you want to allow anyone.",
      "Examples:",
      `- ${SIGNAL_PHONE_NUMBER_EXAMPLE}`,
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      "- *",
      t("wizard.signal.multipleEntries"),
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    message: t("wizard.signal.allowFromPrompt"),
    placeholder: `${SIGNAL_PHONE_NUMBER_EXAMPLE}, uuid:123e4567-e89b-12d3-a456-426614174000`,
    parseEntries: parseSignalAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({ cfg, channel, accountId, allowFrom }),
  });
}

export const signalDmPolicy = {
  label: "Signal",
  channel,
  policyKey: "channels.signal.dmPolicy",
  allowFromKey: "channels.signal.allowFrom",
  resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) =>
    (accountId ?? resolveDefaultSignalAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.signal.dmPolicy",
          allowFromKey: "channels.signal.allowFrom",
        },
  getCurrent: (cfg: OpenClawConfig, accountId?: string) =>
    resolveSignalAccount({ cfg, accountId: accountId ?? resolveDefaultSignalAccountId(cfg) }).config
      .dmPolicy ?? "pairing",
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) =>
    patchChannelConfigForAccount({
      cfg,
      channel,
      accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveSignalAccount({
                  cfg,
                  accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
                }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    }),
  promptAllowFrom: promptSignalAllowFrom,
};

function resolveSignalCliPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}) {
  if (resolveSignalSetupTransportFromCredentialValues(params) !== "native") {
    return undefined;
  }
  return (
    (typeof params.credentialValues.cliPath === "string"
      ? params.credentialValues.cliPath
      : undefined) ??
    resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.cliPath ??
    "signal-cli"
  );
}

export function createSignalCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return {
    ...createCliPathTextInput({
      inputKey: "cliPath",
      message: "signal-cli path",
      helpTitle: "signal-cli path",
      helpLines: [
        "This is the command OpenClaw runs for local signal-cli setup.",
        "Use the full path if it is not on PATH, for example /opt/homebrew/bin/signal-cli.",
      ],
      resolvePath: ({ cfg, accountId, credentialValues }) =>
        resolveSignalCliPath({ cfg, accountId, credentialValues }),
      shouldPrompt,
    }),
    applySet: ({ cfg, accountId, value }) =>
      patchSignalSetupConfigForAccount({
        cfg,
        accountId,
        patch: { cliPath: normalizeOptionalString(value) ?? "signal-cli" },
      }),
  };
}

export const signalNumberTextInput: ChannelSetupWizardTextInput = {
  inputKey: "signalNumber",
  message: t("wizard.signal.botNumberPrompt"),
  placeholder: SIGNAL_PHONE_NUMBER_EXAMPLE,
  helpTitle: "Signal phone number",
  helpLines: [
    "Enter the phone number for the Signal account OpenClaw will use.",
    `Use international format with + and country code, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
  ],
  currentValue: ({ cfg, accountId }) =>
    normalizeSignalAccountInput(resolveSignalAccount({ cfg, accountId }).config.account) ??
    undefined,
  shouldPrompt: ({ cfg, accountId, credentialValues }) =>
    resolveSignalSetupTransportFromCredentialValues({ cfg, accountId, credentialValues }) !==
    "external-native",
  keepPrompt: (value) => t("wizard.signal.accountKeep", { value }),
  validate: ({ value }) =>
    normalizeSignalAccountInput(value)
      ? undefined
      : `Enter a Signal phone number in international format, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
  normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value,
};
