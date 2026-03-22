import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "../runtime-api.js";
import { buildChannelConfigSchema, formatAllowFromLowercase } from "../runtime-api.js";
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

const zalouserConfigAdapter = createScopedChannelConfigAdapter<ResolvedZalouserAccount>({
  sectionKey: "zalouser",
  listAccountIds: listZalouserAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveZalouserAccountSync),
  defaultAccountId: resolveDefaultZalouserAccountId,
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
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalouser|zlu):/i }),
});

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
      ...zalouserConfigAdapter,
      isConfigured: async (account) => await checkZcaAuthenticated(account.profile),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: undefined,
      }),
    },
    setup: params.setup,
  };
}
