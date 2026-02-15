import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CHILDREN_PER_AGENT = 4;

function normalizeTimeoutSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

export function resolveAllowRecursiveSpawn(cfg: OpenClawConfig, agentId: string): boolean {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const perAgent = agentConfig?.subagents?.allowRecursiveSpawn;
  if (typeof perAgent === "boolean") {
    return perAgent;
  }
  const global = cfg.agents?.defaults?.subagents?.allowRecursiveSpawn;
  if (typeof global === "boolean") {
    return global;
  }
  return false;
}

export function resolveMaxSpawnDepth(cfg: OpenClawConfig, agentId: string): number {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const perAgent = agentConfig?.subagents?.maxDepth;
  if (typeof perAgent === "number" && Number.isFinite(perAgent)) {
    return Math.max(1, Math.min(10, Math.floor(perAgent)));
  }
  const global = cfg.agents?.defaults?.subagents?.maxDepth;
  if (typeof global === "number" && Number.isFinite(global)) {
    return Math.max(1, Math.min(10, Math.floor(global)));
  }
  return DEFAULT_MAX_DEPTH;
}

export function resolveMaxChildrenPerAgent(cfg: OpenClawConfig, agentId: string): number {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const perAgent = agentConfig?.subagents?.maxChildrenPerAgent;
  if (typeof perAgent === "number" && Number.isFinite(perAgent)) {
    return Math.max(1, Math.min(20, Math.floor(perAgent)));
  }
  const global = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent;
  if (typeof global === "number" && Number.isFinite(global)) {
    return Math.max(1, Math.min(20, Math.floor(global)));
  }
  return DEFAULT_MAX_CHILDREN_PER_AGENT;
}

export function resolveSubagentRunTimeoutSeconds(cfg: OpenClawConfig, agentId: string): number {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const perAgent = normalizeTimeoutSeconds(agentConfig?.subagents?.runTimeoutSeconds);
  if (perAgent !== undefined) {
    return perAgent;
  }
  const global = normalizeTimeoutSeconds(cfg.agents?.defaults?.subagents?.runTimeoutSeconds);
  if (global !== undefined) {
    return global;
  }
  return 0;
}
