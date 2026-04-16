import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/outbound-runtime";
import { SYSTEM_MARK } from "openclaw/plugin-sdk/text-runtime";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const THREAD_BINDING_PERSONA_MAX_CHARS = 80;

function normalizePersonaLabel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

// F5b (Phase 10 Discord Surface Overhaul): unified persona resolver. All
// three Discord persona sites (intro banner, reply-delivery, outbound-adapter)
// must produce identical output — previously they used different emojis
// (⚙️ vs 🤖) and different label sources, causing the thread identity to
// visibly regress after the intro banner.
//
// Resolution order:
//   1. cfg.agents.<id>.identity (emoji + name) via resolveAgentOutboundIdentity
//   2. SYSTEM_MARK + binding.label
//   3. SYSTEM_MARK + agentId
//   4. SYSTEM_MARK + "agent"
export function resolveThreadBindingPersona(params: {
  label?: string;
  agentId?: string;
  cfg?: OpenClawConfig;
}): string {
  const cfg = params.cfg;
  const agentId = params.agentId;
  if (cfg && agentId) {
    const identity = resolveAgentOutboundIdentity(cfg, agentId);
    const identityName = normalizePersonaLabel(identity?.name);
    if (identityName) {
      const emoji = normalizePersonaLabel(identity?.emoji) ?? SYSTEM_MARK;
      return `${emoji} ${identityName}`.slice(0, THREAD_BINDING_PERSONA_MAX_CHARS);
    }
  }
  const base =
    normalizePersonaLabel(params.label) || normalizePersonaLabel(params.agentId) || "agent";
  return `${SYSTEM_MARK} ${base}`.slice(0, THREAD_BINDING_PERSONA_MAX_CHARS);
}

export function resolveThreadBindingPersonaFromRecord(
  record: ThreadBindingRecord,
  cfg?: OpenClawConfig,
): string {
  return resolveThreadBindingPersona({
    label: record.label,
    agentId: record.agentId,
    cfg,
  });
}
