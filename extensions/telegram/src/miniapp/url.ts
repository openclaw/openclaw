import {
  resolveGatewayPublicOrigin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  resolveTailnetHostWithRunner,
  resolveTailscalePublishedHost,
  type TailscaleStatusCommandRunner,
} from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeControlUiBasePath } from "../control-ui-base-path.js";

export const TELEGRAM_MINIAPP_PATH_PREFIX = "/__openclaw_tg_miniapp/";
export const TELEGRAM_MINIAPP_URL_ERROR =
  "Mini App needs an HTTPS gateway URL. Set an https `gateway.publicOrigin`, or set `gateway.tailscale.mode: serve` or `funnel`, then retry /controlui.";

/** Expected publishing failure whose message is safe to show the bot owner. */
export class TelegramMiniAppUrlError extends Error {}

/** Owner-facing text for a URL resolution failure; unexpected errors stay generic. */
export function describeTelegramMiniAppUrlError(err: unknown): string {
  return err instanceof TelegramMiniAppUrlError ? err.message : TELEGRAM_MINIAPP_URL_ERROR;
}

function telegramMiniAppOriginNotAllowedError(origin: string): string {
  return `Mini App cannot use \`gateway.publicOrigin\` (${origin}) because \`gateway.controlUi.allowedOrigins\` does not include it. Add ${origin} to \`gateway.controlUi.allowedOrigins\`, or set \`gateway.tailscale.mode: serve\` or \`funnel\`, then retry /controlui.`;
}

type TelegramMiniAppUrls = {
  pageUrl: string;
  controlUiUrl: string;
  gatewayUrl: string;
};

export async function resolveTelegramMiniAppUrls(params: {
  cfg: OpenClawConfig;
  runCommand?: TailscaleStatusCommandRunner;
}): Promise<TelegramMiniAppUrls> {
  const basePath = params.cfg.gateway?.controlUi?.basePath;
  const controlUiPath = normalizeControlUiBasePath(
    typeof basePath === "string" ? basePath.trim() : "",
    "all",
  );

  // Telegram only opens HTTPS WebApp URLs, so a non-https public origin falls
  // through to the Tailscale path instead of producing an unusable button.
  const publicOrigin = resolveGatewayPublicOrigin(params.cfg);
  const httpsPublicOrigin = publicOrigin?.startsWith("https://") ? publicOrigin : undefined;
  if (httpsPublicOrigin && isControlUiOriginAllowed(params.cfg, httpsPublicOrigin)) {
    return buildMiniAppUrls(httpsPublicOrigin.slice("https://".length), controlUiPath);
  }
  // A public origin rejected by an explicit allowlist would open a Mini App whose
  // Control UI WebSocket is refused, so keep the Tailscale URL and only name the
  // allowlist when there is no Tailscale fallback.
  const unavailableError = httpsPublicOrigin
    ? telegramMiniAppOriginNotAllowedError(httpsPublicOrigin)
    : TELEGRAM_MINIAPP_URL_ERROR;

  const mode = params.cfg.gateway?.tailscale?.mode ?? "off";
  if (mode !== "serve" && mode !== "funnel") {
    throw new TelegramMiniAppUrlError(unavailableError);
  }

  const tailnetHost = await resolveTailnetHostWithRunner(
    params.runCommand ?? runCommandWithTimeout,
  );
  const publishedHost = resolveTailscalePublishedHost({
    tailscaleMode: mode,
    tailnetHost,
  });
  if (!publishedHost) {
    throw new TelegramMiniAppUrlError(unavailableError);
  }

  return buildMiniAppUrls(publishedHost, controlUiPath);
}

// Mirrors the Gateway Control UI origin allowlist (resolveControlUiAllowedOrigins
// plus checkBrowserOrigin in core): an unset list admits gateway.publicOrigin, an
// authored list (even empty) must contain the origin or "*".
function isControlUiOriginAllowed(cfg: OpenClawConfig, origin: string): boolean {
  const configured = cfg.gateway?.controlUi?.allowedOrigins;
  if (configured === undefined) {
    return true;
  }
  return configured.some((value) => {
    const normalized = normalizeOptionalLowercaseString(value);
    return normalized === "*" || normalized === origin;
  });
}

function buildMiniAppUrls(host: string, controlUiPath: string): TelegramMiniAppUrls {
  return {
    pageUrl: `https://${host}${TELEGRAM_MINIAPP_PATH_PREFIX}`,
    controlUiUrl: `https://${host}${controlUiPath}`,
    // The Control UI serves its WebSocket endpoint under the same base path as
    // the HTTP app (ui/src/app/settings.ts deriveDefaultGatewayUrl); a bare
    // host URL breaks gateway.controlUi.basePath installs.
    gatewayUrl: `wss://${host}${controlUiPath}`,
  };
}
