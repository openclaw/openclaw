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

export function resolveMSTeamsWebhookCollisionIssue(cfg: OpenClawConfig): string | undefined {
  const owners = new Map<string, string>();
  for (const accountId of listMSTeamsAccountIds(cfg)) {
    const account = resolveMSTeamsAccountConfig(cfg, accountId);
    if (account.enabled === false) {
      continue;
    }
    const path = account.webhook?.path || "/api/messages";
    const paths =
      accountId === DEFAULT_ACCOUNT_ID && path !== "/api/messages"
        ? [path, "/api/messages"]
        : [path];
    for (const routePath of paths) {
      const canonical = resolvePluginRoutePathContext(routePath).canonicalPath;
      const owner = owners.get(canonical);
      if (owner && owner !== accountId) {
        return (
          "Microsoft Teams webhook path " +
          routePath +
          " is shared by accounts " +
          owner +
          " and " +
          accountId +
          ". Configure distinct webhook.path values."
        );
      }
      owners.set(canonical, accountId);
    }
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
