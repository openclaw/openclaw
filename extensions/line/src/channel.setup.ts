import {
  buildChannelConfigSchema,
  LineConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedLineAccount,
} from "openclaw/plugin-sdk/line";
import {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../src/line/accounts.js";
import { lineSetupAdapter } from "./setup-core.js";
import { lineSetupWizard } from "./setup-surface.js";

const meta = {
  id: "line",
  label: "LINE",
  selectionLabel: "LINE (Messaging API)",
  detailLabel: "LINE Bot",
  docsPath: "/channels/line",
  docsLabel: "line",
  blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
  systemImage: "message.fill",
} as const;

const normalizeLineAllowFrom = (entry: string) => entry.replace(/^line:(?:user:)?/i, "");

export const lineSetupPlugin: ChannelPlugin<ResolvedLineAccount> = {
  id: "line",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.line"] },
  configSchema: buildChannelConfigSchema(LineConfigSchema),
  config: {
    listAccountIds: (cfg: OpenClawConfig) => listLineAccountIds(cfg),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveLineAccount({ cfg, accountId: accountId ?? undefined }),
    defaultAccountId: (cfg: OpenClawConfig) => resolveDefaultLineAccountId(cfg),
    isConfigured: (account) =>
      Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
      tokenSource: account.tokenSource ?? undefined,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveLineAccount({ cfg, accountId: accountId ?? undefined }).config.allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => normalizeLineAllowFrom(entry)),
  },
  setupWizard: lineSetupWizard,
  setup: lineSetupAdapter,
};
