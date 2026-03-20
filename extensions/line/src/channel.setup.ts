import {
  buildChannelConfigSchema,
  LineConfigSchema,
  type ChannelPlugin,
  type ResolvedLineAccount,
} from "../api.js";
import { lineConfigAdapter } from "./config-adapter.js";
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
    ...lineConfigAdapter,
    isConfigured: (account) =>
      Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
      tokenSource: account.tokenSource ?? undefined,
    }),
  },
  setupWizard: lineSetupWizard,
  setup: lineSetupAdapter,
};
