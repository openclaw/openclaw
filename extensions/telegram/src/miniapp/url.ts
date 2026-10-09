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
import { normalizeControlUiBasePath } from "../control-ui-base-path.js";

export const TELEGRAM_MINIAPP_PATH_PREFIX = "/__openclaw_tg_miniapp/";
export const TELEGRAM_MINIAPP_URL_ERROR =
  "Mini App needs an HTTPS gateway URL. Set an https `gateway.publicOrigin`, or set `gateway.tailscale.mode: serve` or `funnel`, then retry /controlui.";

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
  if (publicOrigin?.startsWith("https://")) {
    return buildMiniAppUrls(publicOrigin.slice("https://".length), controlUiPath);
  }

  const mode = params.cfg.gateway?.tailscale?.mode ?? "off";
  if (mode !== "serve" && mode !== "funnel") {
    throw new Error(TELEGRAM_MINIAPP_URL_ERROR);
  }

  const tailnetHost = await resolveTailnetHostWithRunner(
    params.runCommand ?? runCommandWithTimeout,
  );
  const publishedHost = resolveTailscalePublishedHost({
    tailscaleMode: mode,
    tailnetHost,
  });
  if (!publishedHost) {
    throw new Error(TELEGRAM_MINIAPP_URL_ERROR);
  }

  return buildMiniAppUrls(publishedHost, controlUiPath);
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
