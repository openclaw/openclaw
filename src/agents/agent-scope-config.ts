/** Resolves configured agent ids, directories, workspaces, and merged agent defaults. */
import path from "node:path";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
} from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.js";
import type { AgentMemoryConfig, MemoryExtensionConfig } from "../config/types.memory.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { registerResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace-default.js";

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

/** Per-agent config after applying agent defaults and normalizing scalar fields. */
export type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentEntry["model"];
  thinkingDefault?: AgentEntry["thinkingDefault"];
  verboseDefault?: AgentDefaultsConfig["verboseDefault"];
  reasoningDefault?: AgentEntry["reasoningDefault"];
  fastModeDefault?: AgentEntry["fastModeDefault"];
  contextTokens?: AgentEntry["contextTokens"];
  contextInjection?: AgentEntry["contextInjection"];
  bootstrapMaxChars?: AgentEntry["bootstrapMaxChars"];
  bootstrapTotalMaxChars?: AgentEntry["bootstrapTotalMaxChars"];
  experimental?: AgentDefaultsConfig["experimental"];
  skills?: AgentEntry["skills"];
  memory?: AgentEntry["memory"];
  humanDelay?: AgentEntry["humanDelay"];
  tts?: AgentEntry["tts"];
  contextLimits?: AgentContextLimitsConfig;
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
  runRetries?: AgentEntry["runRetries"];
  embeddedAgent?: AgentEntry["embeddedAgent"];
  sandbox?: AgentEntry["sandbox"];
  tools?: AgentEntry["tools"];
};

let defaultAgentWarned = false;

function warnMultipleDefaultAgents(): void {
  void import("../logging/subsystem.js")
    .then(({ createSubsystemLogger }) => {
      createSubsystemLogger("agent-scope").warn(
        "Multiple agents marked default=true; using the first entry as default.",
      );
    })
    .catch(() => undefined);
}

/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s: string): string {
  return s.replaceAll("\0", "");
}

/** Lists valid configured agent entries from config. */
export function listAgentEntries(cfg: OpenClawConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is AgentEntry => entry !== null && typeof entry === "object");
}

/** Lists unique configured agent ids, falling back to the default agent id. */
export function listAgentIds(cfg: OpenClawConfig): string[] {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return [DEFAULT_AGENT_ID];
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
  return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}

/** Resolves the default agent id, warning once when multiple defaults exist. */
export function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  const defaults = agents.filter((agent) => agent?.default);
  if (defaults.length > 1 && !defaultAgentWarned) {
    defaultAgentWarned = true;
    warnMultipleDefaultAgents();
  }
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

function resolveAgentEntry(cfg: OpenClawConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

/** Resolves merged config for one agent id. */
export function resolveAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentEntry(cfg, id);
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
    thinkingDefault: entry.thinkingDefault,
    verboseDefault: entry.verboseDefault ?? agentDefaults?.verboseDefault,
    reasoningDefault: entry.reasoningDefault,
    fastModeDefault: entry.fastModeDefault,
    contextTokens: entry.contextTokens ?? agentDefaults?.contextTokens,
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
    tts: entry.tts,
    contextLimits:
      typeof entry.contextLimits === "object" && entry.contextLimits
        ? { ...agentDefaults?.contextLimits, ...entry.contextLimits }
        : agentDefaults?.contextLimits,
    heartbeat: entry.heartbeat,
    identity: entry.identity,
    groupChat: entry.groupChat,
    subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
    runRetries:
      typeof entry.runRetries === "object" && entry.runRetries
        ? { ...agentDefaults?.runRetries, ...entry.runRetries }
        : agentDefaults?.runRetries,
    embeddedAgent:
      typeof entry.embeddedAgent === "object" && entry.embeddedAgent
        ? entry.embeddedAgent
        : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ADDITIVE_MEMORY_ARRAY_PATHS = new Set([
  "qmd.paths",
  "search.extraPaths",
  "search.qmd.extraCollections",
]);

function memoryArrayEntryKey(value: unknown): string {
  if (typeof value === "string") {
    return `string:${value}`;
  }
  if (isPlainRecord(value) && typeof value.path === "string") {
    return `path:${value.path}\0${String(value.name ?? "")}\0${String(value.pattern ?? "")}`;
  }
  return `json:${JSON.stringify(value)}`;
}

function mergeAdditiveMemoryArrays(base: unknown[], override: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const value of [...base, ...override]) {
    const key = memoryArrayEntryKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function mergeMemoryConfig(
  global: AgentMemoryConfig | undefined,
  overrides: AgentMemoryConfig | undefined,
): AgentMemoryConfig | undefined {
  if (!global) {
    return overrides;
  }
  if (!overrides) {
    return global;
  }

  const merge = (base: unknown, override: unknown, path: string[]): unknown => {
    if (Array.isArray(base) && Array.isArray(override)) {
      return ADDITIVE_MEMORY_ARRAY_PATHS.has(path.join("."))
        ? mergeAdditiveMemoryArrays(base, override)
        : override;
    }
    if (!isPlainRecord(base) || !isPlainRecord(override)) {
      return override ?? base;
    }
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = key in result ? merge(result[key], value, [...path, key]) : value;
    }
    return result;
  };

  return merge(global, overrides, []) as AgentMemoryConfig;
}

/** Resolves the canonical memory configuration for one agent. */
export function resolveAgentMemoryConfig(
  cfg: OpenClawConfig,
  agentId: string,
): AgentMemoryConfig | undefined {
  return mergeMemoryConfig(cfg.memory, resolveAgentEntry(cfg, agentId)?.memory);
}

/** Resolves one memory extension's merged agent-scoped config. */
export function resolveAgentMemoryExtensionConfig(
  cfg: OpenClawConfig,
  agentId: string,
  extensionId: string,
): MemoryExtensionConfig | undefined {
  return resolveAgentMemoryConfig(cfg, agentId)?.extensions?.[extensionId];
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
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const fallback = cfg.agents?.defaults?.workspace?.trim();
  if (id === defaultAgentId) {
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

export function resolveAgentDir(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  if (configured) {
    const agentDir = resolveUserPath(configured, env);
    registerResolvedAgentDir({ agentId: id, agentDir, env });
    return agentDir;
  }
  const root = resolveStateDir(env);
  const agentDir = path.join(root, "agents", id, "agent");
  registerResolvedAgentDir({ agentId: id, agentDir, env });
  return agentDir;
}

export function resolveDefaultAgentDir(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveAgentDir(cfg, resolveDefaultAgentId(cfg), env);
}
