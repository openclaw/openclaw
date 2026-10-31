import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { MSTeamsConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolveGatewayPort,
  resolvePluginRoutePathContext,
} from "openclaw/plugin-sdk/gateway-config-runtime";
import {
  listMSTeamsAccountIds,
  resolveMSTeamsAccountConfig,
  resolveMSTeamsAccountConfigPath,
  resolveMSTeamsAccountEntryKey,
} from "./accounts.js";

const LEGACY_MESSAGES_PATH = "/api/messages";

function listEnabledMSTeamsWebhookPaths(cfg: OpenClawConfig) {
  return listMSTeamsAccountIds(cfg).flatMap((accountId) => {
    const account = resolveMSTeamsAccountConfig(cfg, accountId);
    if (account.enabled === false) {
      return [];
    }
    const path = account.webhook?.path || LEGACY_MESSAGES_PATH;
    return [{ accountId, path, canonical: resolvePluginRoutePathContext(path).canonicalPath }];
  });
}

/** Enabled account whose configured webhook path is /api/messages, if any. */
export function resolveMSTeamsLegacyMessagesOwner(cfg: OpenClawConfig): string | undefined {
  const legacy = resolvePluginRoutePathContext(LEGACY_MESSAGES_PATH).canonicalPath;
  return listEnabledMSTeamsWebhookPaths(cfg).find(({ canonical }) => canonical === legacy)
    ?.accountId;
}

export function resolveMSTeamsWebhookCollisionIssue(cfg: OpenClawConfig): string | undefined {
  const owners = new Map<string, string>();
  // The default account's legacy /api/messages alias yields to an account configured on it.
  for (const { accountId, path, canonical } of listEnabledMSTeamsWebhookPaths(cfg)) {
    const owner = owners.get(canonical);
    if (owner && owner !== accountId) {
      return (
        "Microsoft Teams webhook path " +
        path +
        " is shared by accounts " +
        owner +
        " and " +
        accountId +
        ". Configure distinct webhook.path values."
      );
    }
    owners.set(canonical, accountId);
  }
  return undefined;
}

export function resolveMSTeamsLegacyWebhook(
  config: Pick<MSTeamsConfig, "legacyWebhook"> | undefined,
) {
  const listener = config?.legacyWebhook;
  return listener || undefined;
}

export function resolveMSTeamsLegacyWebhookConfigPath(cfg: OpenClawConfig, accountId: string) {
  const accountKey = resolveMSTeamsAccountEntryKey(cfg.channels?.msteams?.accounts, accountId);
  return accountKey && cfg.channels?.msteams?.accounts?.[accountKey]?.legacyWebhook
    ? `${resolveMSTeamsAccountConfigPath(cfg, accountId)}.legacyWebhook`
    : "channels.msteams.legacyWebhook";
}

export function resolveMSTeamsWebhookPathIssue({
  cfg,
  env,
  accountId = DEFAULT_ACCOUNT_ID,
  accountConfig = resolveMSTeamsAccountConfig(cfg, accountId),
}: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string;
  accountConfig?: MSTeamsConfig;
}): string | undefined {
  const channel = accountConfig;
  const path = channel?.webhook?.path || "/api/messages";
  const legacy = resolveMSTeamsLegacyWebhook(channel);
  const pathname = URL.parse(path, "http://localhost")?.pathname ?? path;
  const probe = classifyGatewayProbePath(pathname);
  const protectedPath = isProtectedPluginRoutePathFromContext(
    resolvePluginRoutePathContext(pathname),
  );
  const reason = protectedPath
    ? "requires Gateway authentication on the main HTTP listener"
    : probe !== "namespace" && probe !== "outside"
      ? "is reserved for Gateway checks"
      : /[:*{}\\]/.test(path)
        ? "uses Express pattern syntax that requires the compatibility listener"
        : undefined;
  if (!reason) {
    return undefined;
  }
  const configPath = resolveMSTeamsAccountConfigPath(cfg, accountId);
  const recoveryPath =
    accountId === DEFAULT_ACCOUNT_ID ? "/api/messages" : `/api/messages/${accountId}`;
  return (
    `Microsoft Teams webhook path ${path} ${reason}. ` +
    `Set ${configPath}.webhook.path to ${recoveryPath} and update the Azure Bot messaging endpoint or reverse-proxy upstream to Gateway port ${resolveGatewayPort(cfg, env)}${recoveryPath}.` +
    (legacy
      ? ` Compatibility port ${legacy.port} continues serving the current path; verify delivery before removing ${resolveMSTeamsLegacyWebhookConfigPath(cfg, accountId)}.`
      : " The compatibility listener is disabled, so this path cannot receive Teams callbacks.")
  );
}
