import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { DEFAULT_HUB_PERCENTILE } from "./page-budget.js";
import { AGENT_ID, STORE_KEY, type GrantAccess } from "./stores-contract.js";
export const agentIdPattern = new RegExp(AGENT_ID);

const NamedStore = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    agents: Type.Array(Type.String({ pattern: AGENT_ID }), { maxItems: 100 }),
  },
  { additionalProperties: false },
);
type NamedStore = Static<typeof NamedStore>;
export const StoresSection = Type.Record(Type.String({ pattern: STORE_KEY }), NamedStore, {
  additionalProperties: false,
});
export type StoresSection = Static<typeof StoresSection>;

/** Authored plugin configuration. Membership is the only per-agent setting;
 * everything else is a plugin-wide gate. */
export const PluginConfig = Type.Object(
  {
    operatorRead: Type.Optional(Type.Boolean()),
    writesEnabled: Type.Optional(Type.Boolean()),
    stores: Type.Optional(StoresSection),
    pageBudgets: Type.Optional(
      Type.Object(
        {
          hubPercentile: Type.Optional(
            Type.Number({
              minimum: 50,
              maximum: 99.9,
              description:
                "Authored-link degree percentile, within each store partition, at which a page counts as a hub and gets the smaller body budget. Default 90.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    maintenance: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(
            Type.Boolean({
              description:
                "Run the scheduled maintenance pass over every configured store. Default true.",
            }),
          ),
          schedule: Type.Optional(
            Type.String({
              minLength: 9,
              maxLength: 100,
              description: "Five-field cron expression. Default 30 3 * * * (03:30 daily).",
            }),
          ),
          timezone: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 100,
              description:
                "IANA time zone for the schedule. Default: the Gateway host's time zone.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PluginConfig = Static<typeof PluginConfig>;
/** Scheduled maintenance settings; validated when scheduling, so a bad
 * expression is reported in the UI instead of disabling the plugin. */
type MaintenanceSettings = {
  enabled: boolean;
  schedule: string;
  timezone: string;
};
export type Policy = {
  operatorRead: boolean;
  writesEnabled: boolean;
  hubPercentile: number;
  maintenance: MaintenanceSettings;
};
const DEFAULT_MAINTENANCE_SCHEDULE = "30 3 * * *";

/** Config path owned by the no-reload rule and every membership write. */
export const STORES_CONFIG_PATH = ["plugins", "entries", "knowledge", "config", "stores"] as const;

/** Plugin-wide gates. All default on so a fresh install works without authoring config. */
export function parsePolicy(config: Record<string, unknown> | undefined): Policy {
  const value = config ?? {};
  if (!Check(PluginConfig, value)) {
    throw new Error("Knowledge configuration is invalid; review plugins.entries.knowledge.config.");
  }
  const maintenance = value.maintenance ?? {};
  return {
    operatorRead: value.operatorRead ?? true,
    writesEnabled: value.writesEnabled ?? true,
    hubPercentile: value.pageBudgets?.hubPercentile ?? DEFAULT_HUB_PERCENTILE,
    maintenance: {
      enabled: maintenance.enabled ?? true,
      schedule: maintenance.schedule ?? DEFAULT_MAINTENANCE_SCHEDULE,
      timezone: maintenance.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}

/** Read the authored `stores` section out of a full host config snapshot. */
export function readStoresSection(hostConfig: unknown): unknown {
  let node: unknown = hostConfig;
  for (const key of STORES_CONFIG_PATH) {
    if (!node || typeof node !== "object") {
      return {};
    }
    // SAFETY: node is a non-null object (checked above); an absent key reads undefined.
    node = (node as Record<string, unknown>)[key];
  }
  return node ?? {};
}

// Key-sorted JSON so equal sections always hash equally.
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/** Settings revision: a hash of the stores section only (spec §4.1). */
export function storesRevision(section: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(section ?? {}))
    .digest("hex");
}

/** Result of validating membership. Invalid agents never fall back to a first
 * match; they are unavailable until the configuration is repaired. */
export type Membership = {
  section: StoresSection;
  revision: string;
  /** Agent -> named store key, for validly assigned agents only. */
  assigned: ReadonlyMap<string, string>;
  /** Agents with ambiguous or otherwise invalid membership. */
  invalid: ReadonlySet<string>;
  issues: string[];
};

/** Validate an authored stores section. A structurally invalid section makes
 * every listed agent invalid rather than silently ignoring the section. */
export function parseMembership(raw: unknown): Membership {
  const revision = storesRevision(raw),
    issues: string[] = [];
  const assigned = new Map<string, string>(),
    invalid = new Set<string>();
  if (!Check(StoresSection, raw)) {
    // Salvage agent names so the affected agents are reported, never defaulted.
    const entries: unknown[] = Object.values(raw && typeof raw === "object" ? raw : {});
    for (const entry of entries) {
      const agents = entry && typeof entry === "object" && "agents" in entry ? entry.agents : [];
      for (const agent of Array.isArray(agents) ? agents : []) {
        if (typeof agent === "string") {
          invalid.add(agent);
        }
      }
    }
    return {
      section: {},
      revision,
      assigned,
      invalid,
      issues: [
        "The stores configuration is invalid; affected agents are unavailable until it is repaired.",
      ],
    };
  }
  const labels = new Map<string, string>();
  for (const [key, store] of Object.entries(raw)) {
    const label = (store.label ?? key).trim().toLowerCase();
    if (labels.has(label)) {
      issues.push(`Stores "${labels.get(label)}" and "${key}" share a display name.`);
    }
    labels.set(label, key);
    for (const agent of store.agents) {
      const previous = assigned.get(agent);
      if (previous !== undefined && previous !== key) {
        invalid.add(agent);
        issues.push(`Agent "${agent}" is assigned to both "${previous}" and "${key}".`);
      } else {
        assigned.set(agent, key);
      }
    }
  }
  for (const agent of invalid) {
    assigned.delete(agent);
  }
  return { section: raw, revision, assigned, invalid, issues };
}

/** Logical binding for an agent: its named store, or its isolated default. */
export type Binding = `agent:${string}` | `named:${string}`;
export function effectiveBinding(membership: Membership, agentId: string): Binding | undefined {
  if (membership.invalid.has(agentId)) {
    return undefined;
  }
  const key = membership.assigned.get(agentId);
  return key === undefined ? `agent:${agentId}` : `named:${key}`;
}

/** Owner grants keyed by a conversation's stable session key. */
export type ConversationGrants = Record<string, GrantAccess>;
/** Revision operators edit grants against: a hash of the grants only. */
export const grantsRevision = (grants: ConversationGrants) => storesRevision(grants);

/** The grant covering a conversation: its own key's, else the nearest
 * `:`-delimited ancestor's. Thread, topic and other key-denoted child sessions
 * extend their conversation's key, so they inherit its grant; a more specific
 * grant wins. Session keys are read as structure only, never as authority: the
 * key comes from the host-minted audience. */
export function coveringGrant(
  grants: ConversationGrants,
  sessionKey: string,
): GrantAccess | undefined {
  for (let key = sessionKey; ;) {
    if (Object.hasOwn(grants, key)) {
      return grants[key];
    }
    const at = key.lastIndexOf(":");
    if (at <= 0) {
      return undefined;
    }
    key = key.slice(0, at);
  }
}
