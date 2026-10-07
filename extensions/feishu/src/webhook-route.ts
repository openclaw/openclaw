import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  resolveGatewayPort,
} from "openclaw/plugin-sdk/gateway-config-runtime";
import { listFeishuAccountIds, mergeFeishuAccountConfig } from "./accounts.js";
import type { FeishuConfig } from "./types.js";
import { DEFAULT_FEISHU_WEBHOOK_PATH, normalizeFeishuWebhookPath } from "./webhook-path.js";

export function resolveFeishuLegacyWebhookListener(
  config: Pick<FeishuConfig, "legacyWebhook">,
): { port: number; host: string } | undefined {
  const listener = config.legacyWebhook;
  return listener ? { port: listener.port, host: listener.host ?? "127.0.0.1" } : undefined;
}

export function describeFeishuWebhookPathConflict(path: string): string | undefined {
  const normalized = normalizeFeishuWebhookPath(path);
  if (!normalized) {
    return undefined;
  }
  const pathname = new URL(normalized, "http://localhost").pathname;
  const probe = classifyGatewayProbePath(pathname);
  let reason: string;
  if (probe !== "outside" && probe !== "namespace") {
    reason = "is reserved for Gateway probes";
  } else if (isProtectedPluginRoutePathFromContext(resolvePluginRoutePathContext(pathname))) {
    reason = "requires Gateway authentication";
  } else {
    return undefined;
  }
  return `webhookPath ${JSON.stringify(path)} ${reason}. Set webhookPath to ${DEFAULT_FEISHU_WEBHOOK_PATH} and update the Feishu callback URL or reverse-proxy path to match.`;
}

export function collectFeishuWebhookNotes({
  cfg,
  env,
}: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  const infoNotes: string[] = [];
  const warningNotes: string[] = [];
  for (const accountId of listFeishuAccountIds(cfg)) {
    const account = mergeFeishuAccountConfig(cfg, accountId);
    if (
      cfg.channels?.feishu?.enabled === false ||
      account.enabled === false ||
      account.connectionMode !== "webhook"
    ) {
      continue;
    }
    const route = account.webhookPath ?? DEFAULT_FEISHU_WEBHOOK_PATH;
    const legacyListener = resolveFeishuLegacyWebhookListener(account);
    const pathConflict = describeFeishuWebhookPathConflict(route);
    if (pathConflict) {
      warningNotes.push(
        `Feishu account "${accountId}" ${pathConflict} ${legacyListener ? "The legacyWebhook listener keeps the old path working. Move webhookPath and the callback or proxy before removing the legacyWebhook pin." : "Webhook startup is blocked until the path is changed."} Use Gateway port ${resolveGatewayPort(cfg, env)}.`,
      );
      continue;
    }
    const upstream = `Gateway port ${resolveGatewayPort(cfg, env)}, path ${route}`;
    infoNotes.push(
      `Feishu account "${accountId}" uses ${upstream}. Point the Feishu callback URL or reverse-proxy upstream there; accounts sharing a path need distinct encrypt keys. ${legacyListener ? `The legacy listener on ${legacyListener.host}:${legacyListener.port} forwards into that same route. After verifying delivery through the Gateway, remove the legacyWebhook pin; use legacyWebhook:false to override an inherited endpoint.` : "No legacy listener is configured; callbacks use the Gateway route."}`,
    );
  }
  return { infoNotes, warningNotes };
}
