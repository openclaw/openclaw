import {
  resolveGatewayPublicOrigin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
} from "openclaw/plugin-sdk/gateway-config-runtime";

export const DEFAULT_TELEGRAM_WEBHOOK_PATH = "/telegram-webhook";

export function resolveTelegramGatewayWebhookUrl(
  config: OpenClawConfig | undefined,
  path: string,
): string | undefined {
  const origin = resolveGatewayPublicOrigin(config);
  return origin
    ? URL.parse(`${origin}${path.startsWith("/") ? path : `/${path}`}`)?.href
    : undefined;
}

type TelegramWebhookPathConflict = {
  kind: "health" | "probe" | "auth";
  message: string;
};

export function resolveTelegramWebhookPathConflict(
  path: string,
): TelegramWebhookPathConflict | undefined {
  if (path === "/healthz") {
    return { kind: "health", message: "is reserved for webhook listener health checks" };
  }
  const pathname = URL.parse(path, "http://localhost")?.pathname ?? path;
  const probe = classifyGatewayProbePath(pathname);
  if (probe === "live" || probe === "ready" || probe === "startup") {
    return { kind: "probe", message: "is reserved for Gateway probes" };
  }
  if (isProtectedPluginRoutePathFromContext(resolvePluginRoutePathContext(pathname))) {
    return { kind: "auth", message: "requires Gateway authentication" };
  }
  return undefined;
}
