/** Resolves configured agent ids, directories, workspaces, and merged agent defaults. */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../cli/command-format.js";
import { getRetainedLegacyDefaultAgentId } from "../config/legacy.default-agent-owner-state.js";
import { hasExplicitModelPolicyAllow } from "../config/model-policy-allowlist-migration.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
} from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { resolveUserPath } from "../utils.js";
import { registerResolvedAgentDir } from "./agent-dir-registry.js";
import {
  hasAgentRosterProperty,
  listAgentEntriesWithSource,
  listAgentIds,
  readAgentRosterProperty,
  tryResolveLegacyDataOwner,
  tryResolveRawLegacyDefaultAgentId,
  tryResolveSoleAgentId,
} from "./agent-roster.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace-default.js";

export {
  hasAgentRosterProperty,
  listAgentEntries,
  listAgentEntriesWithSource,
  listAgentIds,
  readAgentRosterProperty,
  tryResolveDefaultAgentId,
  tryResolveSoleAgentId,
  type ListedAgentEntry,
} from "./agent-roster.js";

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
type AgentEntriesConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>;
type MutableAgentEntry = AgentEntry | AgentEntriesConfig[string];
export type AgentSelectionContext = {
  surface: string;
  hint: string;
};

export class AgentSelectionRequiredError extends Error {
  readonly code = "AGENT_SELECTION_REQUIRED";
  readonly agentIds: string[];
  readonly surface: string;
  readonly hint: string;

  constructor(agentIds: string[], context?: AgentSelectionContext) {
    const surface = context?.surface ?? "this operation";
    const hint =
      context?.hint ??
      "Select an agent explicitly; CLI callers can pass --agent <id>, channels can add a binding, and ambient services can set their agentId target.";
    super(`Multiple agents are configured, but ${surface} has no explicit owner. ${hint}`);
    this.name = "AgentSelectionRequiredError";
    this.agentIds = agentIds;
    this.surface = surface;
    this.hint = hint;
  }
}

/** Per-agent config after applying agent defaults and normalizing scalar fields. */
export type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentEntry["model"];
  models?: AgentEntry["models"];
  params?: AgentEntry["params"];
  runtime?: AgentEntry["runtime"];
  modelPolicy?: AgentEntry["modelPolicy"];
  agentRuntime?: AgentEntry["agentRuntime"];
  utilityModel?: AgentEntry["utilityModel"];
  decisionModel?: AgentEntry["decisionModel"];
  decisionModelsByTask?: AgentEntry["decisionModelsByTask"];
  thinkingDefault?: AgentEntry["thinkingDefault"];
  verboseDefault?: AgentDefaultsConfig["verboseDefault"];
  toolProgressDetail?: AgentDefaultsConfig["toolProgressDetail"];
  reasoningDefault?: AgentEntry["reasoningDefault"];
  fastModeDefault?: AgentEntry["fastModeDefault"];
  contextInjection?: AgentEntry["contextInjection"];
  bootstrapMaxChars?: AgentEntry["bootstrapMaxChars"];
  bootstrapTotalMaxChars?: AgentEntry["bootstrapTotalMaxChars"];
  experimental?: AgentDefaultsConfig["experimental"];
  skills?: AgentEntry["skills"];
  memory?: AgentEntry["memory"];
  humanDelay?: AgentEntry["humanDelay"];
  typingMode?: AgentEntry["typingMode"];
  tts?: AgentEntry["tts"];
  contextLimits?: AgentContextLimitsConfig;
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
  embeddedAgent?: AgentEntry["embeddedAgent"];
  sandbox?: AgentEntry["sandbox"];
  tools?: AgentEntry["tools"];
};

/** ACP primaries select the harness; explicit fallback lists still configure native calls. */
export function resolveAgentModelConfigForRuntime(
  agent: Pick<ResolvedAgentConfig, "model" | "runtime"> | undefined,
  runtime: "native" | "acp" = "native",
): ResolvedAgentConfig["model"] {
  const model = agent?.model;
  if (runtime === "acp" || agent?.runtime?.type !== "acp") {
    return model;
  }
  return model && typeof model === "object" && Array.isArray(model.fallbacks)
    ? { fallbacks: model.fallbacks }
    : undefined;
}

/** Native overrides exclude ACP harness primaries without changing authored configuration. */
export function resolveAgentNativeModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  return resolvePrimaryStringValue(
    resolveAgentModelConfigForRuntime(resolveAgentConfig(cfg, agentId)),
  );
}

/** Native requests inherit the raw default, including its configured auth-profile suffix. */
export function resolveNativeModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  return (
    resolveAgentNativeModelPrimary(cfg, agentId) ??
    resolvePrimaryStringValue(cfg.agents?.defaults?.model)
  );
}

/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s: string): string {
  return s.replaceAll("\0", "");
}

type AgentRosterFacts = {
  compatibilityAgentId?: { value: string | undefined };
  legacyDataOwnerAgentId?: { value: string | undefined };
  entryByNormalizedId?: Map<string, { clone: boolean; entry: AgentEntry }>;
};

type AgentRosterFactsBatch = {
  config: OpenClawConfig;
  facts: AgentRosterFacts;
};

let activeAgentRosterFactsBatch: AgentRosterFactsBatch | undefined;
const immutableAgentRosterFacts = new WeakMap<
  OpenClawConfig,
  { legacyOwner: string | undefined; facts: AgentRosterFacts }
>();

/**
 * Runs a read-only callback with batch-scoped roster memoization.
 *
 * Runtime discovery calls the owner helpers for every configured model. Keep
 * their derived facts on this exact config. Mutable callers discard the batch
 * before returning; immutable captures retain facts for their own lifetime.
 */
export function withAgentRosterFactsBatch<T>(config: OpenClawConfig, callback: () => T): T {
  const parent = activeAgentRosterFactsBatch;
  activeAgentRosterFactsBatch =
    parent?.config === config ? parent : { config, facts: readAgentRosterFacts(config) ?? {} };
  try {
    return callback();
  } finally {
    activeAgentRosterFactsBatch = parent;
  }
}

function readAgentRosterFacts(cfg: OpenClawConfig): AgentRosterFacts | undefined {
  if (activeAgentRosterFactsBatch?.config === cfg) {
    return activeAgentRosterFactsBatch.facts;
  }
  if (!isDeeplyFrozenPlainData(cfg)) {
    return undefined;
  }
  // Migration provenance lives outside the immutable config and can still change.
  const legacyOwner = getRetainedLegacyDefaultAgentId(cfg);
  let cached = immutableAgentRosterFacts.get(cfg);
  if (!cached || cached.legacyOwner !== legacyOwner) {
    cached = { legacyOwner, facts: {} };
    immutableAgentRosterFacts.set(cfg, cached);
  }
  return cached.facts;
}

/** Converts either supported roster representation into the canonical keyed shape. */
export function toAgentEntriesRecord(entries: readonly AgentEntry[]): AgentEntriesConfig {
  return Object.fromEntries(
    entries.map((entry) => {
      const { id, ...config } = entry;
      return [id, config];
    }),
  );
}

/** Returns a configured agent id or throws the canonical CLI selection error. */
export function resolveConfiguredAgentId(cfg: OpenClawConfig, agentId: string): string {
  if (!listAgentIds(cfg).includes(agentId)) {
    // formatCliCommand, not a literal: under a profile or container the bare command is wrong,
    // so a hint that cannot be pasted back is worse than none.
    throw new Error(
      `Unknown agent id "${agentId}". Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
  }
  return agentId;
}

export function resolveSoleAgentId(cfg: OpenClawConfig, context?: AgentSelectionContext): string {
  const sole = tryResolveSoleAgentId(cfg);
  if (sole) {
    return sole;
  }
  const agentIds = listAgentIds(cfg);
  if (agentIds.length === 0) {
    throw new Error("No agents configured. Run `openclaw onboard` or `openclaw agents add` first.");
  }
  throw new AgentSelectionRequiredError(agentIds, context);
}

/** Preserves legacy data locators independently of the configured runtime owner. */
export function tryResolveLegacyDataOwnerAgentId(cfg: OpenClawConfig): string | undefined {
  const facts = readAgentRosterFacts(cfg);
  if (facts?.legacyDataOwnerAgentId) {
    return facts.legacyDataOwnerAgentId.value;
  }
  const value = tryResolveLegacyDataOwner(cfg);
  if (facts) {
    facts.legacyDataOwnerAgentId = { value };
  }
  return value;
}

/** Resolves the recorded default after migration, or a sole/raw legacy owner. */
export function tryResolveLegacyCompatibilityAgentId(cfg: OpenClawConfig): string | undefined {
  const facts = readAgentRosterFacts(cfg);
  if (facts?.compatibilityAgentId) {
    return facts.compatibilityAgentId.value;
  }
  let value: string | undefined;
  if (cfg.agents?.ownership === "explicit") {
    // Migration's systemAgent.agentId is the durable default; provenance cannot designate one.
    const recorded = normalizeOptionalString(cfg.agents.defaults?.systemAgent?.agentId);
    const agentId = recorded ? normalizeAgentId(recorded) : undefined;
    value = agentId && listAgentIds(cfg).includes(agentId) ? agentId : undefined;
  } else {
    value = tryResolveLegacyDataOwnerAgentId(cfg);
  }
  if (facts) {
    facts.compatibilityAgentId = { value };
  }
  return value;
}

/** Resolves the owner for ambient system work and explicit requests. */
export function tryResolveAmbientOwnerAgentId(
  cfg: OpenClawConfig,
  requestedAgentId?: string,
): string | undefined {
  const explicitAgentId =
    normalizeOptionalString(requestedAgentId) ??
    normalizeOptionalString(cfg.agents?.defaults?.systemAgent?.agentId);
  // The documented system-agent owner is explicit config, so it precedes a stripped legacy marker.
  return explicitAgentId
    ? normalizeAgentId(explicitAgentId)
    : (tryResolveLegacyCompatibilityAgentId(cfg) ?? tryResolveSoleAgentId(cfg));
}

/** Ambient owner for surfaces that must fail loudly rather than act on the wrong agent. */
export function resolveAmbientOwnerAgentId(
  cfg: OpenClawConfig,
  requestedAgentId?: string,
  context?: AgentSelectionContext,
): string {
  return tryResolveAmbientOwnerAgentId(cfg, requestedAgentId) ?? resolveSoleAgentId(cfg, context);
}

/** Returns an operation owner while preserving legacy defaults outside explicit fleets. */
export function tryResolveAgentOperationAgentId(
  cfg: OpenClawConfig,
  requestedAgentId?: string,
): string | undefined {
  if (requestedAgentId !== undefined) {
    return tryResolveAmbientOwnerAgentId(cfg, requestedAgentId);
  }
  return tryResolveLegacyCompatibilityAgentId(cfg) ?? tryResolveSoleAgentId(cfg);
}

/** Resolves a CLI operation owner, requiring selection when no owner is configured. */
export function resolveAgentOperationAgentId(
  cfg: OpenClawConfig,
  requestedAgentId?: string,
  context?: AgentSelectionContext,
): string {
  return tryResolveAgentOperationAgentId(cfg, requestedAgentId) ?? resolveSoleAgentId(cfg, context);
}

/**
 * @deprecated Ambient system work uses resolveAmbientOwnerAgentId so the configured
 * system agent is honored; explicit-selection surfaces use resolveSoleAgentId. This
 * accepts raw shipped markers only for input compatibility.
 */
export function resolveDefaultAgentId(
  cfg: OpenClawConfig,
  context?: AgentSelectionContext,
): string {
  return tryResolveRawLegacyDefaultAgentId(cfg) ?? resolveSoleAgentId(cfg, context);
}

export function resolveAgentEntry(cfg: OpenClawConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  const facts = readAgentRosterFacts(cfg);
  if (facts) {
    // Point lookups inside a batch reuse one first-match index instead of
    // re-traversing the roster per model ref (#135743).
    const byId = (facts.entryByNormalizedId ??= buildAgentEntryIndex(cfg));
    const found = byId.get(id);
    return found ? (found.clone ? { ...found.entry } : found.entry) : undefined;
  }
  // Point lookups are hot; the public list helper must clone every keyed entry.
  // Traverse the roster directly so a match does not project unrelated agents.
  const roster = readAgentRosterProperty(cfg);
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    const entries = roster.value;
    for (const key in entries) {
      if (!Object.hasOwn(entries, key)) {
        continue;
      }
      const entry = entries[key];
      if (isRecord(entry) && normalizeAgentId(key) === id) {
        return { ...entry, id: key };
      }
    }
    return undefined;
  }
  if (roster?.kind === "list" && Array.isArray(roster.value)) {
    return (roster.value as AgentEntry[]).find(
      (entry) => entry !== null && typeof entry === "object" && normalizeAgentId(entry.id) === id,
    );
  }
  return undefined;
}

/**
 * First-match index over the projected roster for batch point lookups.
 *
 * Keyed entries must stay clone-on-read (callers may mutate the returned
 * entry); list entries keep the original object, matching the direct
 * traversal semantics of `resolveAgentEntry` outside a batch.
 */
function buildAgentEntryIndex(
  cfg: OpenClawConfig,
): Map<string, { clone: boolean; entry: AgentEntry }> {
  const index = new Map<string, { clone: boolean; entry: AgentEntry }>();
  for (const { entry, source } of listAgentEntriesWithSource(cfg)) {
    const normalizedId = normalizeAgentId(entry?.id);
    if (!index.has(normalizedId)) {
      index.set(normalizedId, { clone: source.kind === "entries", entry });
    }
  }
  return index;
}

/** Resolves the authored entry object for in-place canonical config mutations. */
export function resolveMutableAgentEntry(
  cfg: OpenClawConfig,
  agentId: string,
): MutableAgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  const roster = readAgentRosterProperty(cfg);
  if (roster?.kind === "entries" && roster.value && typeof roster.value === "object") {
    const entries = roster.value as AgentEntriesConfig;
    const key = Object.keys(entries).find((candidate) => normalizeAgentId(candidate) === id);
    return key ? entries[key] : undefined;
  }
  if (roster?.kind === "list" && Array.isArray(roster.value)) {
    return (roster.value as AgentEntry[]).find((entry) => normalizeAgentId(entry?.id) === id);
  }
  return undefined;
}

/** Resolves merged config for one agent id. */
export function resolveAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry: AgentEntry | undefined =
    resolveAgentEntry(cfg, id) ??
    (!hasAgentRosterProperty(cfg) && id === LEGACY_IMPLICIT_AGENT_ID ? { id } : undefined);
  if (!entry) {
    return undefined;
  }
  const agentDefaults = cfg.agents?.defaults;
  return {
    name: readStringValue(entry.name),
    workspace: readStringValue(entry.workspace),
    agentDir: readStringValue(entry.agentDir),
    model:
      typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
        ? entry.model
        : undefined,
    ...(entry.models ? { models: entry.models } : {}),
    ...(entry.params ? { params: entry.params } : {}),
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    ...(hasExplicitModelPolicyAllow(entry.modelPolicy) ? { modelPolicy: entry.modelPolicy } : {}),
    ...(entry.agentRuntime ? { agentRuntime: entry.agentRuntime } : {}),
    utilityModel: readStringValue(entry.utilityModel),
    decisionModel: readStringValue(entry.decisionModel),
    decisionModelsByTask: entry.decisionModelsByTask,
    thinkingDefault: entry.thinkingDefault,
    verboseDefault: entry.verboseDefault ?? agentDefaults?.verboseDefault,
    toolProgressDetail: entry.toolProgressDetail ?? agentDefaults?.toolProgressDetail,
    reasoningDefault: entry.reasoningDefault,
    fastModeDefault: entry.fastModeDefault ?? agentDefaults?.fastModeDefault,
    contextInjection: entry.contextInjection,
    bootstrapMaxChars: entry.bootstrapMaxChars,
    bootstrapTotalMaxChars: entry.bootstrapTotalMaxChars,
    experimental:
      typeof entry.experimental === "object" && entry.experimental
        ? { ...agentDefaults?.experimental, ...entry.experimental }
        : agentDefaults?.experimental,
    skills: Array.isArray(entry.skills) ? entry.skills : undefined,
    memory: entry.memory,
    humanDelay: entry.humanDelay,
    typingMode: entry.typingMode ?? agentDefaults?.typingMode,
    tts: entry.tts,
    contextLimits:
      typeof entry.contextLimits === "object" && entry.contextLimits
        ? { ...agentDefaults?.contextLimits, ...entry.contextLimits }
        : agentDefaults?.contextLimits,
    heartbeat: entry.heartbeat,
    identity: entry.identity,
    groupChat: entry.groupChat,
    subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
    embeddedAgent:
      typeof entry.embeddedAgent === "object" && entry.embeddedAgent
        ? entry.embeddedAgent
        : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
  };
}

export function resolveAgentContextLimits(
  cfg: OpenClawConfig | undefined,
  agentId?: string | null,
): AgentContextLimitsConfig | undefined {
  const defaults = cfg?.agents?.defaults?.contextLimits;
  if (!cfg || !agentId) {
    return defaults;
  }
  return resolveAgentConfig(cfg, agentId)?.contextLimits ?? defaults;
}

export function resolveAgentWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) {
    return stripNullBytes(resolveUserPath(configured, env));
  }
  // Read-time migration removes default:true before write-time workspace pinning can run.
  const inheritedWorkspaceAgentId = tryResolveLegacyDataOwnerAgentId(cfg);
  const fallback = cfg.agents?.defaults?.workspace?.trim();
  if (inheritedWorkspaceAgentId && id === inheritedWorkspaceAgentId) {
    if (fallback) {
      return stripNullBytes(resolveUserPath(fallback, env));
    }
    return stripNullBytes(resolveDefaultAgentWorkspaceDir(env));
  }
  if (fallback) {
    return stripNullBytes(path.join(resolveUserPath(fallback, env), id));
  }
  const stateDir = resolveStateDir(env);
  return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}

/** Resolves the configured task directory without changing the agent workspace. */
export function resolveAgentRunCwd(cfg: OpenClawConfig, agentId: string): string | undefined {
  const cwd =
    normalizeOptionalString(resolveAgentEntry(cfg, agentId)?.cwd) ??
    normalizeOptionalString(cfg.agents?.defaults?.cwd);
  return cwd ? stripNullBytes(resolveUserPath(cwd)) : undefined;
}

/** How a resolved agent workspace should be provisioned by the lifecycle owner. */
export type AgentWorkspaceProvisioning = "standard" | "runtime-managed-implicit";

/**
 * Resolves whether an agent's workspace is runtime-managed and implicit.
 *
 * A workspace is runtime-managed-implicit only when all of the following hold:
 * - the agent runs the ACP runtime (non-embedded),
 * - the agent entry does not configure an explicit `workspace`,
 * - the provisioned directory is the config-resolved implicit workspace, and
 * - this invocation has a distinct authoritative cwd: the invocation cwd when
 *   known (session ACP meta or the configured binding that owns the session
 *   key), otherwise the agent-global runtime `acp.cwd` default. A cwd equal to
 *   the resolved workspace is not distinct.
 *
 * Such agents must not get a scaffolded default workspace with bootstrap
 * files and `git init` (#92015). Every other shape — explicit workspaces,
 * ACP agents that fall back to their workspace as cwd, and embedded agents —
 * keeps standard provisioning.
 */
export function resolveAgentWorkspaceProvisioning(
  cfg: OpenClawConfig,
  agentId: string,
  invocation?: {
    /** Effective cwd for this invocation, if known. */
    cwd?: string;
    /** Directory being provisioned; defaults to the config-resolved implicit workspace. */
    workspaceDir?: string;
  },
): AgentWorkspaceProvisioning {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentConfig(cfg, id);
  if (entry?.runtime?.type !== "acp") {
    return "standard";
  }
  if (entry.workspace?.trim()) {
    return "standard";
  }
  const implicitDir = resolveAgentWorkspaceDir(cfg, id);
  const workspaceDir = invocation?.workspaceDir?.trim()
    ? resolveUserPath(invocation.workspaceDir)
    : implicitDir;
  // A provisioned dir that differs from the config-resolved implicit workspace
  // is an explicit selection (for example a spawned-context override).
  if (workspaceDir !== implicitDir) {
    return "standard";
  }
  const cwd = normalizeOptionalString(invocation?.cwd)?.trim() ?? entry.runtime.acp?.cwd?.trim();
  if (!cwd) {
    return "standard";
  }
  if (path.resolve(resolveUserPath(cwd)) === path.resolve(workspaceDir)) {
    return "standard";
  }
  return "runtime-managed-implicit";
}

/**
 * Cheap candidate check for turn-level provisioning resolution: true only for
 * ACP agents without an explicit workspace, so heavier invocation-cwd lookups
 * (configured binding resolution) stay off embedded/default agent turns.
 */
export function isImplicitAcpWorkspaceCandidate(cfg: OpenClawConfig, agentId: string): boolean {
  const entry = resolveAgentConfig(cfg, normalizeAgentId(agentId));
  return entry?.runtime?.type === "acp" && !entry.workspace?.trim();
}

export function tryResolveConfiguredAgentWorkspaceDir(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const inheritedWorkspaceAgentId = tryResolveLegacyDataOwnerAgentId(cfg);
  if (inheritedWorkspaceAgentId) {
    return resolveAgentWorkspaceDir(cfg, inheritedWorkspaceAgentId, env);
  }
  const configured = cfg.agents?.defaults?.workspace?.trim();
  return configured ? stripNullBytes(resolveUserPath(configured, env)) : undefined;
}

type AgentDirResolutionEnv = { env?: NodeJS.ProcessEnv; homedir?: () => string };

// Per-agent paths stay independent of process-wide install overrides.
export function resolveEffectiveAgentDir(
  cfg: OpenClawConfig,
  agentId: string,
  deps?: AgentDirResolutionEnv,
): string {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  const env = deps?.env ?? process.env;
  return configured
    ? resolveUserPath(configured, env, deps?.homedir)
    : path.join(resolveStateDir(env, deps?.homedir), "agents", id, "agent");
}

export function resolveAgentDir(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const agentDir = resolveEffectiveAgentDir(cfg, agentId, { env });
  registerResolvedAgentDir({ agentId, agentDir, env });
  return agentDir;
}

export function resolveDefaultAgentDir(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveAgentDir(cfg, resolveAmbientOwnerAgentId(cfg), env);
}
