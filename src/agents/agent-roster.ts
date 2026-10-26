import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { LegacyAgentListEntry } from "../config/legacy.roster.js";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getMainThreadTaskName, runWithMainThreadTask } from "../infra/main-thread-stall.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  normalizeOptionalAgentId,
} from "../routing/session-key.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { SYSTEM_AGENT_ROSTER_ENTRIES } from "../system-agent/agent-id.js";

type AgentEntry = AgentConfig;
type AgentRosterProperty = { kind: "entries" | "list"; value: unknown };
type AgentRosterConfig = {
  readonly agents?: {
    readonly ownership?: "explicit";
    readonly entries?: Readonly<Record<string, unknown>>;
    readonly list?: readonly unknown[];
  };
};
export type ListedAgentEntry = {
  entry: AgentEntry;
  source: { kind: "entries"; key: string } | { kind: "list"; index: number };
};
type ListedLegacyAgentEntry = {
  entry: LegacyAgentListEntry;
  source: ListedAgentEntry["source"];
};

type AgentRosterFacts = {
  agentIds?: string[];
  compatibilityAgentId?: { value: string | undefined };
  legacyDataOwnerAgentId?: { value: string | undefined };
  entryByNormalizedId?: Map<string, { clone: boolean; entry: AgentEntry }>;
};

type AgentRosterFactsBatch = {
  config: AgentRosterConfig;
  facts: AgentRosterFacts;
};

let activeAgentRosterFactsBatch: AgentRosterFactsBatch | undefined;
const agentRosterFacts = new WeakMap<
  AgentRosterConfig,
  { publication: object | undefined; facts: AgentRosterFacts }
>();

/** Share roster reads synchronously; unbound mutable configs expire when the callback returns. */
export function withAgentRosterFactsBatch<T>(config: AgentRosterConfig, callback: () => T): T {
  return runWithMainThreadTask(
    getMainThreadTaskName() ?? "gateway",
    () => {
      const parent = activeAgentRosterFactsBatch;
      activeAgentRosterFactsBatch =
        parent?.config === config ? parent : { config, facts: readAgentRosterFacts(config) ?? {} };
      try {
        return callback();
      } finally {
        activeAgentRosterFactsBatch = parent;
      }
    },
    "agent-roster",
  );
}

export function readAgentRosterFacts(cfg: AgentRosterConfig): AgentRosterFacts | undefined {
  if (activeAgentRosterFactsBatch?.config === cfg) {
    return activeAgentRosterFactsBatch.facts;
  }
  const current = runtimeConfigPublication.current;
  const publication = current?.config === cfg ? current.revision : undefined;
  if (publication === undefined && !isDeeplyFrozenPlainData(cfg)) {
    return undefined;
  }
  let cached = agentRosterFacts.get(cfg);
  if (!cached || cached.publication !== publication) {
    cached = { publication, facts: {} };
    agentRosterFacts.set(cfg, cached);
  }
  return cached.facts;
}

function collectAgentEntries(
  cfg: AgentRosterConfig,
  withSource: true,
  limit?: number,
): ListedLegacyAgentEntry[];
function collectAgentEntries(
  cfg: AgentRosterConfig,
  withSource: false,
  limit?: number,
): LegacyAgentListEntry[];
function collectAgentEntries(
  cfg: AgentRosterConfig,
  withSource: boolean,
  limit?: number,
): Array<LegacyAgentListEntry | ListedLegacyAgentEntry> {
  const roster = readAgentRosterProperty(cfg);
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    const result: Array<LegacyAgentListEntry | ListedLegacyAgentEntry> = [];
    for (const id in roster.value) {
      if (!Object.hasOwn(roster.value, id)) {
        continue;
      }
      const entry = roster.value[id];
      if (isRecord(entry)) {
        const projected = { ...entry, id };
        result.push(
          withSource ? { entry: projected, source: { kind: "entries", key: id } } : projected,
        );
        if (result.length === limit) {
          break;
        }
      }
    }
    return result;
  }
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return [];
  }
  const listed: ListedLegacyAgentEntry[] = [];
  roster.value.some((entry, index) => {
    if (entry !== null && typeof entry === "object") {
      // SAFETY: Raw roster compatibility keeps objects verbatim; callers normalize ids.
      listed.push({ entry: entry as LegacyAgentListEntry, source: { kind: "list", index } });
    }
    return listed.length === limit;
  });
  return withSource ? listed : listed.map(({ entry }) => entry);
}

/** Lists valid configured agent entries from config. */
export function listAgentEntriesWithSource(cfg: AgentRosterConfig): ListedAgentEntry[] {
  return collectAgentEntries(cfg, true);
}

/** Lists valid configured agent entries from either supported representation. */
export function listAgentEntries(cfg: AgentRosterConfig): AgentEntry[] {
  return collectAgentEntries(cfg, false);
}

/** Reads the explicitly owned raw roster without normalizing malformed values. */
export function readAgentRosterProperty(raw: unknown): AgentRosterProperty | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const agents = raw.agents;
  if (!isRecord(agents)) {
    return undefined;
  }
  for (const kind of ["entries", "list"] as const) {
    const value = agents[kind];
    if (Object.hasOwn(agents, kind) && value !== undefined) {
      return { kind, value };
    }
  }
  return undefined;
}

/** True when raw config explicitly owns either supported roster representation. */
export function hasAgentRosterProperty(raw: unknown): boolean {
  return readAgentRosterProperty(raw) !== undefined;
}

/** Lists unique configured agent ids. */
export function listAgentIds(cfg: AgentRosterConfig): string[] {
  const facts = readAgentRosterFacts(cfg);
  if (facts?.agentIds) {
    return facts.agentIds;
  }
  const agents = listAgentEntries(cfg);
  // Match resolveDefaultAgentId's Plugin SDK compatibility for raw pre-roster configs.
  const ids =
    agents.length === 0 && !hasAgentRosterProperty(cfg)
      ? [LEGACY_IMPLICIT_AGENT_ID]
      : [...new Set(agents.map((entry) => normalizeAgentId(entry?.id)))];
  if (facts) {
    // Published generations and immutable captures share ids, never mutable entry objects.
    Object.freeze(ids);
    facts.agentIds = ids;
  }
  return ids;
}

/** Lists ACP harness ids and ACP-runtime roster agents named by config; native agents are excluded. */
export function resolveConfiguredAcpHarnessIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  for (const agent of listAgentEntries(cfg)) {
    if (agent.runtime?.type !== "acp") {
      continue;
    }
    ids.add(normalizeAgentId(agent.id));
    const acpAgent = normalizeOptionalAgentId(agent.runtime.acp?.agent);
    if (acpAgent) {
      ids.add(acpAgent);
    }
  }
  const candidates = [
    cfg.acp?.defaultAgent,
    ...(cfg.acp?.allowedAgents ?? []).filter((entry) => entry.trim() !== "*"),
  ];
  for (const entry of candidates) {
    const id = normalizeOptionalAgentId(entry);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

/** Lists configured roster and ACP harness targets for subagent policy. */
export function resolveConfiguredAcpSubagentTargetIds(cfg: OpenClawConfig): Set<string> {
  return new Set([...listAgentIds(cfg), ...resolveConfiguredAcpHarnessIds(cfg)]);
}

/** Reserved system agents belong to the Gateway without authored roster entries. */
export function listGatewayOwnedAgentIds(cfg: AgentRosterConfig): string[] {
  return [...new Set([...listAgentIds(cfg), ...SYSTEM_AGENT_ROSTER_ENTRIES.map(({ id }) => id)])];
}

export function tryResolveSoleAgentId(cfg: AgentRosterConfig): string | undefined {
  const agents = collectAgentEntries(cfg, false, 2);
  if (agents.length === 0) {
    if (!hasAgentRosterProperty(cfg)) {
      return LEGACY_IMPLICIT_AGENT_ID;
    }
    return undefined;
  }
  return agents.length === 1 ? normalizeAgentId(agents[0]!.id) : undefined;
}

export function tryResolveRawLegacyDefaultAgentId(cfg: AgentRosterConfig): string | undefined {
  if (cfg.agents?.ownership === "explicit") {
    return undefined;
  }
  const marked = collectAgentEntries(cfg, false).filter((entry) => entry.default === true);
  return marked.length === 1 ? normalizeAgentId(marked[0]!.id) : undefined;
}

/** @deprecated Use tryResolveSoleAgentId; accepts raw shipped markers only for input compatibility. */
export function tryResolveDefaultAgentId(cfg: AgentRosterConfig): string | undefined {
  return tryResolveRawLegacyDefaultAgentId(cfg) ?? tryResolveSoleAgentId(cfg);
}

/** Preserves legacy data locators independently of the configured runtime owner. */
export function tryResolveLegacyDataOwner(cfg: AgentRosterConfig): string | undefined {
  return tryResolveDefaultAgentId(cfg);
}
