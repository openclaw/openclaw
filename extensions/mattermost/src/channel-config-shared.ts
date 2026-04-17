import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  type ResolvedMattermostAccount,
} from "./mattermost/accounts.js";
import type { MattermostSlashCommandConfig } from "./mattermost/slash-commands.js";
import type { MattermostConfig } from "./types.js";

export const mattermostMeta = {
  id: "mattermost",
  label: "Mattermost",
  selectionLabel: "Mattermost (plugin)",
  detailLabel: "Mattermost Bot",
  docsPath: "/channels/mattermost",
  docsLabel: "mattermost",
  blurb: "self-hosted Slack-style chat; install the plugin to enable.",
  systemImage: "bubble.left.and.bubble.right",
  order: 65,
  quickstartAllowFrom: true,
} as const;

const DEFAULT_SLASH_CALLBACK_PATH = "/api/channels/mattermost/command";

export function normalizeMattermostAllowEntry(entry: string): string {
  return normalizeLowercaseStringOrEmpty(
    entry
      .trim()
      .replace(/^(mattermost|user):/i, "")
      .replace(/^@/, ""),
  );
}

export function formatMattermostAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    return username ? `@${normalizeLowercaseStringOrEmpty(username)}` : "";
  }
  return normalizeLowercaseStringOrEmpty(trimmed.replace(/^(mattermost|user):/i, ""));
}

export function collectMattermostSlashCallbackPaths(
  raw?: Partial<MattermostSlashCommandConfig>,
): string[] {
  const callbackPath = (() => {
    const trimmed = raw?.callbackPath?.trim();
    if (!trimmed) {
      return DEFAULT_SLASH_CALLBACK_PATH;
    }
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  })();
  const callbackUrl = raw?.callbackUrl?.trim();
  const paths = new Set<string>([callbackPath]);
  if (callbackUrl) {
    try {
      const pathname = new URL(callbackUrl).pathname;
      if (pathname) {
        paths.add(pathname);
      }
    } catch {
      // Keep the normalized callback path when the configured URL is invalid.
    }
  }
  return [...paths];
}

export function resolveMattermostGatewayAuthBypassPaths(cfg: {
  channels?: Record<string, unknown>;
}): string[] {
  const base = cfg.channels?.mattermost as MattermostConfig | undefined;
  const callbackPaths = new Set(
    collectMattermostSlashCallbackPaths(
      base?.commands as Partial<MattermostSlashCommandConfig> | undefined,
    ).filter(
      (path) =>
        path === "/api/channels/mattermost/command" || path.startsWith("/api/channels/mattermost/"),
    ),
  );
  const accounts = base?.accounts ?? {};
  for (const account of Object.values(accounts)) {
    const accountConfig =
      account && typeof account === "object" && !Array.isArray(account)
        ? (account as {
            commands?: Parameters<typeof collectMattermostSlashCallbackPaths>[0];
          })
        : undefined;
    for (const path of collectMattermostSlashCallbackPaths(accountConfig?.commands)) {
      if (
        path === "/api/channels/mattermost/command" ||
        path.startsWith("/api/channels/mattermost/")
      ) {
        callbackPaths.add(path);
      }
    }
  }
  return [...callbackPaths];
}

export const mattermostConfigAdapter = createScopedChannelConfigAdapter<ResolvedMattermostAccount>({
  sectionKey: "mattermost",
  listAccountIds: listMattermostAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMattermostAccount),
  defaultAccountId: resolveDefaultMattermostAccountId,
  clearBaseFields: ["botToken", "baseUrl", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: formatMattermostAllowEntry,
    }),
});

export function isMattermostConfigured(account: ResolvedMattermostAccount): boolean {
  return Boolean(account.botToken && account.baseUrl);
}

export function describeMattermostAccount(account: ResolvedMattermostAccount) {
  return describeAccountSnapshot({
    account,
    configured: isMattermostConfigured(account),
    extra: {
      botTokenSource: account.botTokenSource,
      baseUrl: account.baseUrl,
    },
  });
}
