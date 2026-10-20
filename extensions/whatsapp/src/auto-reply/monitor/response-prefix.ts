import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveIdentityNamePrefix } from "./runtime-api.js";

export function resolveWhatsAppResponsePrefix(params: {
  cfg: OpenClawConfig;
  agentId: string;
  isSelfChat: boolean;
  pipelineResponsePrefix?: string;
}): string | undefined {
  const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
  return (
    params.pipelineResponsePrefix ??
    (configuredResponsePrefix === "auto"
      ? resolveIdentityNamePrefix(params.cfg, params.agentId)
      : configuredResponsePrefix) ??
    (params.isSelfChat ? resolveIdentityNamePrefix(params.cfg, params.agentId) : undefined)
  );
}
