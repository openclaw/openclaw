import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
} from "openclaw/plugin-sdk/gateway-config-runtime";
import type { NextcloudTalkAccountConfig } from "./types.js";

export const DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH = "/nextcloud-talk-webhook";

export function resolveNextcloudTalkLegacyWebhook(config: NextcloudTalkAccountConfig) {
  const listener = config.legacyWebhook;
  if (listener === false) {
    return undefined;
  }
  return { port: listener?.port ?? 8788, host: listener?.host ?? "0.0.0.0" };
}

export function describeNextcloudTalkWebhookRouteConflict(
  path: string,
  gatewayPort: number,
): string | undefined {
  const pathname = URL.parse(path, "http://localhost")?.pathname ?? path;
  const probe = classifyGatewayProbePath(pathname);
  const reason =
    probe !== "outside" && probe !== "namespace"
      ? "is reserved for Gateway probes"
      : isProtectedPluginRoutePathFromContext(resolvePluginRoutePathContext(pathname))
        ? "requires Gateway authentication"
        : undefined;
  if (!reason) {
    return undefined;
  }
  return (
    `Webhook path "${path}" ${reason} and cannot receive Nextcloud callbacks on the Gateway port. ` +
    `Set webhookPath to "${DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH}" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port ${gatewayPort}${DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH}.`
  );
}
