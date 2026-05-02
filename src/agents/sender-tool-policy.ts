import {
  resolveToolsBySender,
  type GroupToolPolicySender,
} from "../config/group-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";

/**
 * Resolves a per-sender tool policy from the global or per-agent `toolsBySender` config.
 *
 * This enables capability tiers per user identity, regardless of channel or group context.
 * When a sender's policy denies (or does not include) a tool, that tool is stripped from the
 * list passed to the LLM — it does not appear in the model's tool schema at all.
 *
 * Lookup priority:
 *   1. agents.<agentId>.tools.toolsBySender  (agent-level, highest priority)
 *   2. tools.toolsBySender                  (global fallback)
 *
 * Within each level, key priority: channel → id → e164 → username → name → "*" (wildcard).
 *
 * ## YAML config example
 *
 * ```yaml
 * tools:
 *   toolsBySender:
 *     # Owner: explicit no-op entry — all tools available (default behaviour).
 *     "username:jerra": {}
 *     # Named friend: can chat and read but cannot exec or write to disk.
 *     "username:bob":
 *       deny: [exec, process, write, edit]
 *     # Everyone else: no shell or filesystem writes.
 *     "*":
 *       deny: [exec, process, write, edit]
 * ```
 *
 * Because tools are removed from the schema the model receives, it genuinely has no knowledge
 * of the denied capabilities for that sender and will tell the user it cannot perform those
 * operations rather than attempting and failing.
 */
export function resolveGlobalSenderToolPolicy(
  params: {
    config?: OpenClawConfig;
    agentId?: string;
  } & GroupToolPolicySender,
): SandboxToolPolicy | undefined {
  if (!params.config) {
    return undefined;
  }

  const sender: GroupToolPolicySender = {
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    messageProvider: params.messageProvider,
  };

  // Agent-level toolsBySender takes priority over the global list.
  const agentConfig = params.agentId
    ? resolveAgentConfig(params.config, params.agentId)
    : undefined;

  const agentSenderPolicy = resolveToolsBySender({
    toolsBySender: agentConfig?.tools?.toolsBySender,
    ...sender,
  });
  if (agentSenderPolicy) {
    return pickSandboxToolPolicy(agentSenderPolicy);
  }

  // Fall back to global tools.toolsBySender.
  const globalSenderPolicy = resolveToolsBySender({
    toolsBySender: params.config.tools?.toolsBySender,
    ...sender,
  });
  return pickSandboxToolPolicy(globalSenderPolicy);
}
