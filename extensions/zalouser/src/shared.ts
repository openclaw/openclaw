import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/zalouser";
import {
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  formatAllowFromLowercase,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/zalouser";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  checkZcaAuthenticated,
  type ResolvedZalouserAccount,
} from "./accounts.js";
import { ZalouserConfigSchema } from "./config-schema.js";

export const zalouserMeta = {
  id: "zalouser",
  label: "Zalo Personal",
  selectionLabel: "Zalo (Personal Account)",
  docsPath: "/channels/zalouser",
  docsLabel: "zalouser",
  blurb: "Zalo personal account via QR code login.",
  aliases: ["zlu"],
  order: 85,
  quickstartAllowFrom: false,
} satisfies ChannelPlugin<ResolvedZalouserAccount>["meta"];

export function createZalouserPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedZalouserAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedZalouserAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedZalouserAccount>,
  "id" | "meta" | "setupWizard" | "capabilities" | "reload" | "configSchema" | "config" | "setup"
> {
  return {
    id: "zalouser",
    meta: zalouserMeta,
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      reactions: true,
      threads: false,
      polls: false,
      nativeCommands: false,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.zalouser"] },
    configSchema: buildChannelConfigSchema(ZalouserConfigSchema),
    config: {
      listAccountIds: (cfg) => listZalouserAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolveZalouserAccountSync({ cfg, accountId }),
      defaultAccountId: (cfg) => resolveDefaultZalouserAccountId(cfg),
      setAccountEnabled: ({ cfg, accountId, enabled }) =>
        setAccountEnabledInConfigSection({
          cfg,
          sectionKey: "zalouser",
          accountId,
          enabled,
          allowTopLevel: true,
        }),
      deleteAccount: ({ cfg, accountId }) =>
        deleteAccountFromConfigSection({
          cfg,
          sectionKey: "zalouser",
          accountId,
          clearBaseFields: [
            "profile",
            "name",
            "dmPolicy",
            "allowFrom",
            "historyLimit",
            "groupAllowFrom",
            "groupPolicy",
            "groups",
            "messagePrefix",
          ],
        }),
      isConfigured: async (account) => await checkZcaAuthenticated(account.profile),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: undefined,
      }),
      resolveAllowFrom: ({ cfg, accountId }) =>
        mapAllowFromEntries(resolveZalouserAccountSync({ cfg, accountId }).config.allowFrom),
      formatAllowFrom: ({ allowFrom }) =>
        formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalouser|zlu):/i }),
    },
    setup: params.setup,
  };
}
