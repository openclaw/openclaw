import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { MSTeamsConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolveGatewayPort,
  resolvePluginRoutePathContext,
} from "openclaw/plugin-sdk/gateway-config-runtime";
import { listMSTeamsAccountIds, resolveMSTeamsAccountConfig } from "./accounts.js";

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

export function resolveMSTeamsWebhookPathIssue({
  cfg,
  env,
}: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const channel = cfg.channels?.msteams;
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
  return (
    `Microsoft Teams webhook path ${path} ${reason}. ` +
    `Set channels.msteams.webhook.path to /api/messages and update the Azure Bot messaging endpoint or reverse-proxy upstream to Gateway port ${resolveGatewayPort(cfg, env)}/api/messages; verify delivery before removing channels.msteams.legacyWebhook.` +
    (legacy
      ? ` Compatibility port ${legacy.port} continues serving the current path.`
      : " The compatibility listener is disabled, so this path cannot receive Teams callbacks.")
  );
}
