import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import type { AgentComponentContext } from "./agent-components-helpers.js";

export function resolveComponentGroupPolicy(
  ctx: AgentComponentContext,
): "open" | "disabled" | "allowlist" {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: ctx.cfg.channels?.discord !== undefined,
    groupPolicy: ctx.discordConfig?.groupPolicy,
    defaultGroupPolicy: ctx.cfg.channels?.defaults?.groupPolicy,
  }).groupPolicy;
}
