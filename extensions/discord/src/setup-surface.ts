import { resolveBasicAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  createSetupTranslator,
  patchChannelConfigForAccount,
  promptResolvedAllowFrom,
  resolveEntriesWithOptionalToken,
  resolveSetupAccountId,
  splitSetupEntries,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { resolveDefaultDiscordAccountId, resolveDiscordAccountAllowFrom } from "./accounts.js";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import { resolveDiscordSetupAccountConfig } from "./setup-account-state.js";
import {
  createDiscordSetupWizardBase,
  getDiscordAllowFromHelpLines,
  parseDiscordAllowFromId,
} from "./setup-core.js";
import { resolveDiscordToken } from "./token.js";

const t = createSetupTranslator();

const channel = "discord" as const;

async function promptDiscordAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultDiscordAccountId(params.cfg),
  });
  const account = resolveDiscordSetupAccountConfig({ cfg: params.cfg, accountId });
  const noteTitle = t("wizard.discord.allowlistTitle");
  await params.prompter.note(getDiscordAllowFromHelpLines().join("\n"), noteTitle);
  const allowFrom = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: resolveDiscordAccountAllowFrom({ cfg: params.cfg, accountId }) ?? [],
    token: resolveDiscordToken(params.cfg, { accountId }).token,
    message: t("wizard.discord.allowFromPrompt"),
    placeholder: "@alice, 123456789012345678",
    label: noteTitle,
    parseInputs: splitSetupEntries,
    parseId: parseDiscordAllowFromId,
    invalidWithoutTokenNote: t("wizard.discord.allowFromInvalidWithoutToken"),
    resolveEntries: async ({ token, entries }) =>
      await resolveBasicAllowFromEntries({
        token,
        entries,
        resolveEntries: resolveDiscordUserAllowlist,
      }),
  });
  return patchChannelConfigForAccount({
    cfg: params.cfg,
    channel,
    accountId: account.accountId,
    patch: {
      allowFrom,
      dm: {
        ...account.config.dm,
        enabled: typeof account.config.dm?.enabled === "boolean" ? account.config.dm.enabled : true,
      },
    },
  });
}

export const discordSetupWizard: ChannelSetupWizard = createDiscordSetupWizardBase({
  promptAllowFrom: promptDiscordAllowFrom,
  resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) =>
    await resolveBasicAllowFromEntries({
      token:
        resolveDiscordToken(cfg, { accountId }).token ||
        (typeof credentialValues.token === "string" ? credentialValues.token : ""),
      entries,
      resolveEntries: resolveDiscordUserAllowlist,
    }),
  resolveGroupAllowlist: async (params) =>
    await resolveEntriesWithOptionalToken({
      token:
        resolveDiscordToken(params.cfg, { accountId: params.accountId }).token ||
        (typeof params.credentialValues.token === "string" ? params.credentialValues.token : ""),
      entries: params.entries,
      buildWithoutToken: (input) => ({ input, resolved: false }),
      resolveEntries: resolveDiscordChannelAllowlist,
    }),
});
