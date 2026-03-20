import type { ChannelPlugin } from "../api.js";
import {
  resolveLineAccount,
  type OpenClawConfig,
  type ResolvedLineAccount,
} from "../runtime-api.js";
import { lineConfigAdapter } from "./config-adapter.js";
import { LineChannelConfigSchema } from "./config-schema.js";

export const lineChannelMeta = {
  id: "line",
  label: "LINE",
  selectionLabel: "LINE (Messaging API)",
  detailLabel: "LINE Bot",
  docsPath: "/channels/line",
  docsLabel: "line",
  blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
  systemImage: "message.fill",
} as const;

export const lineChannelPluginCommon = {
  meta: {
    ...lineChannelMeta,
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
  configSchema: LineChannelConfigSchema,
  config: {
    ...lineConfigAdapter,
    isConfigured: (account: ResolvedLineAccount) =>
      Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
    describeAccount: (account: ResolvedLineAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
      tokenSource: account.tokenSource ?? undefined,
    }),
  },
} satisfies Pick<
  ChannelPlugin<ResolvedLineAccount>,
  "meta" | "capabilities" | "reload" | "configSchema" | "config"
>;

export function isLineConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const resolved = resolveLineAccount({ cfg, accountId });
  return Boolean(resolved.channelAccessToken.trim() && resolved.channelSecret.trim());
}

export function parseLineAllowFromId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
  if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../runtime-api.js";
