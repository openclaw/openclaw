import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMSTeamsCredentials } from "./token.js";

export type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

export const msteamsMeta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Teams SDK; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

export const msteamsConfigAdapter = createTopLevelChannelConfigAdapter<
  ResolvedMSTeamsAccount,
  {
    allowFrom?: Array<string | number>;
    defaultTo?: string;
  }
>({
  sectionKey: "msteams",
  resolveAccount: (cfg) => ({
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: cfg.channels?.msteams?.enabled !== false,
    configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
  }),
  resolveAccessorAccount: ({ cfg }) => ({
    allowFrom: cfg.channels?.msteams?.allowFrom,
    defaultTo: cfg.channels?.msteams?.defaultTo,
  }),
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});

export const resolveMSTeamsDmPolicy = createScopedDmSecurityResolver<ResolvedMSTeamsAccount>({
  channelKey: "msteams",
  resolvePolicy: () => undefined,
  resolveAllowFrom: () => undefined,
  resolveAccess: ({ cfg }) => ({
    dmPolicy: cfg.channels?.msteams?.dmPolicy,
    allowFrom: cfg.channels?.msteams?.allowFrom,
  }),
  policyPathSuffix: "dmPolicy",
  // Keep audit counting aligned with inbound sender-id matching; prefixes are not aliases.
  normalizeEntry: normalizeLowercaseStringOrEmpty,
});
