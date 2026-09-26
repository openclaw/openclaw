import type { MSTeamsConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolveGatewayPort,
  resolvePluginRoutePathContext,
} from "openclaw/plugin-sdk/gateway-config-runtime";

export function resolveMSTeamsLegacyWebhook(
  config: Pick<MSTeamsConfig, "legacyWebhook"> | undefined,
) {
  const listener = config?.legacyWebhook;
  return listener === false ? undefined : (listener ?? { port: 3978 });
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
      ? "is reserved for Gateway probes"
      : /[:*{}\\]/.test(path)
        ? "uses Express pattern syntax that requires the compatibility listener"
        : undefined;
  if (!reason) {
    return undefined;
  }
  return (
    `Microsoft Teams webhook path ${path} ${reason}. ` +
    `Set channels.msteams.webhook.path to /api/messages and update the Azure Bot messaging endpoint or reverse-proxy upstream to Gateway port ${resolveGatewayPort(cfg, env)}/api/messages; verify delivery before setting channels.msteams.legacyWebhook=false.` +
    (legacy
      ? ` Compatibility port ${legacy.port} continues serving the current path.`
      : " The compatibility listener is disabled, so this path cannot receive Teams callbacks.")
  );
}
