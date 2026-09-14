import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRetainedLegacyDefaultAgentId } from "../config/legacy.default-agent-owner-state.js";
import type { OpenClawConfig } from "../config/types.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
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

/** Lists valid configured agent entries from config. */
export function listAgentEntriesWithSource(cfg: AgentRosterConfig): ListedAgentEntry[] {
  const roster = readAgentRosterProperty(cfg);
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    return Object.entries(roster.value).flatMap(([id, entry]) =>
      isRecord(entry)
        ? [
            {
              entry: { ...entry, id },
              source: { kind: "entries" as const, key: id },
            },
          ]
        : [],
    );
  }
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return [];
  }
  return roster.value.flatMap((entry, index) =>
    entry !== null && typeof entry === "object"
      ? [{ entry: entry as AgentEntry, source: { kind: "list" as const, index } }] // SAFETY: Raw roster compatibility keeps objects verbatim; callers normalize ids.
      : [],
  );
}

/** Lists valid configured agent entries from either supported representation. */
export function listAgentEntries(cfg: AgentRosterConfig): AgentEntry[] {
  return listAgentEntriesWithSource(cfg).map(({ entry }) => entry);
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
  const entries = agents["entries"];
  if (Object.hasOwn(agents, "entries") && entries !== undefined) {
    return { kind: "entries", value: entries };
  }
  const list = agents["list"];
  if (Object.hasOwn(agents, "list") && list !== undefined) {
    return { kind: "list", value: list };
  }
  return undefined;
}

/** True when raw config explicitly owns either supported roster representation. */
export function hasAgentRosterProperty(raw: unknown): boolean {
  return readAgentRosterProperty(raw) !== undefined;
}

/** Lists unique configured agent ids. */
export function listAgentIds(cfg: AgentRosterConfig): string[];
// Keep shipped full-config overloads last for Parameters<typeof> consumers.
export function listAgentIds(cfg: OpenClawConfig): string[];
export function listAgentIds(cfg: AgentRosterConfig): string[] {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0 && !hasAgentRosterProperty(cfg)) {
    // Match resolveDefaultAgentId's Plugin SDK compatibility for raw pre-roster configs.
    return [LEGACY_IMPLICIT_AGENT_ID];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of agents) {
    const id = normalizeAgentId(entry?.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function tryResolveSoleAgentId(cfg: AgentRosterConfig): string | undefined {
  const agents = listAgentEntries(cfg);
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
  const marked = listAgentEntries(cfg).filter((entry) => entry.default === true);
  return marked.length === 1 ? normalizeAgentId(marked[0]!.id) : undefined;
}

/** @deprecated Use tryResolveSoleAgentId; accepts raw shipped markers only for input compatibility. */
export function tryResolveDefaultAgentId(cfg: AgentRosterConfig): string | undefined;
/** @deprecated Use tryResolveSoleAgentId; accepts raw shipped markers only for input compatibility. */
export function tryResolveDefaultAgentId(cfg: OpenClawConfig): string | undefined;
export function tryResolveDefaultAgentId(cfg: AgentRosterConfig): string | undefined {
  return tryResolveRawLegacyDefaultAgentId(cfg) ?? tryResolveSoleAgentId(cfg);
}

/** Preserves legacy data locators independently of the configured runtime owner. */
export function tryResolveLegacyDataOwner(cfg: AgentRosterConfig): string | undefined {
  const retained = getRetainedLegacyDefaultAgentId(cfg);
  return retained && listAgentIds(cfg).includes(retained)
    ? retained
    : tryResolveDefaultAgentId(cfg);
}
