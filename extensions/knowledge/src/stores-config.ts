import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { AGENT_ID, STORE_KEY } from "./stores-contract.js";
export const agentIdPattern = new RegExp(AGENT_ID);
const storeKeyPattern = new RegExp(STORE_KEY);

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

const REVIEW_JOB_DESCRIPTION =
  "Automation run after each maintenance pass that leaves private claims reachable from no page. Its agent turn follows the knowledge-unlinked-claims skill. When unset, maintenance runs the automation with declaration key knowledge:scribe:unlinked-review. Disable the automation to pause the review.";
/** Authored plugin configuration. Membership is the only per-agent setting;
 * everything else is a plugin-wide gate. */
export const PluginConfig = Type.Object(
  {
    operatorRead: Type.Optional(Type.Boolean()),
    writesEnabled: Type.Optional(Type.Boolean()),
    stores: Type.Optional(StoresSection),
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
          reviewJobId: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 100,
              description: REVIEW_JOB_DESCRIPTION,
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
  reviewJobId?: string;
};
export type Policy = {
  operatorRead: boolean;
  writesEnabled: boolean;
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
    maintenance: {
      enabled: maintenance.enabled ?? true,
      schedule: maintenance.schedule ?? DEFAULT_MAINTENANCE_SCHEDULE,
      timezone: maintenance.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(maintenance.reviewJobId ? { reviewJobId: maintenance.reviewJobId } : {}),
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
  if (!Check(StoresSection, raw) || Object.keys(raw).some((key) => !storeKeyPattern.test(key))) {
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
