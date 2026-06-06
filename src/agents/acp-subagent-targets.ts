// Resolves configured ACP harness agent ids for store scans and spawn routing.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentIds } from "./agent-scope.js";

function normalizeOptionalAgentId(value: string | undefined | null): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return undefined;
  }
  return normalizeAgentId(trimmed);
}

export function resolveConfiguredAcpSubagentTargetIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>(listAgentIds(cfg));
  for (const agent of cfg.agents?.list ?? []) {
    if (agent.runtime?.type !== "acp") {
      continue;
    }
    const acpAgent = normalizeOptionalAgentId(agent.runtime.acp?.agent);
    if (acpAgent) {
      ids.add(acpAgent);
    }
  }
  const defaultAgent = normalizeOptionalAgentId(cfg.acp?.defaultAgent);
  if (defaultAgent) {
    ids.add(defaultAgent);
  }
  for (const entry of cfg.acp?.allowedAgents ?? []) {
    if (entry.trim() === "*") {
      continue;
    }
    const id = normalizeOptionalAgentId(entry);
    if (id) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}
