import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type { WecomConfig, WecomNetworkConfig } from "../types/index.js";

export function resolveWecomEgressProxyUrlFromNetwork(network?: WecomNetworkConfig): string | undefined {
  const env = (process.env.OPENCLAW_WECOM_EGRESS_PROXY_URL ?? process.env.WECOM_EGRESS_PROXY_URL ?? "").trim();
  if (env) return env;

  const fromCfg = network?.egressProxyUrl?.trim() ?? "";
  return fromCfg || undefined;
}

export function resolveWecomEgressProxyUrl(cfg: OpenClawConfig): string | undefined {
  const wecom = cfg.channels?.wecom as WecomConfig | undefined;
  return resolveWecomEgressProxyUrlFromNetwork(wecom?.network);
}
