import {
  buildChannelConfigSchema,
  LineConfigSchema,
  type ChannelPlugin,
  type ResolvedLineAccount,
} from "../api.js";
import {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../runtime-api.js";
import { normalizeLineAllowFrom } from "./config-adapter.js";
import { lineSetupAdapter } from "./setup-core.js";
import { lineSetupWizard } from "./setup-surface.js";
import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";

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

/**
 * Setup-safe config adapter that uses pure core functions instead of
 * getLineRuntime(), which is unavailable during setup-only registration.
 */
const lineSetupConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedLineAccount,
  ResolvedLineAccount,
  import("../api.js").OpenClawConfig
>({
  sectionKey: "line",
  listAccountIds: (cfg) => listLineAccountIds(cfg),
  resolveAccount: (cfg, accountId) =>
    resolveLineAccount({ cfg, accountId: accountId ?? undefined }),
  defaultAccountId: (cfg) => resolveDefaultLineAccountId(cfg),
  clearBaseFields: ["channelSecret", "tokenFile", "secretFile"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map(normalizeLineAllowFrom),
});

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
    ...lineSetupConfigAdapter,
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
