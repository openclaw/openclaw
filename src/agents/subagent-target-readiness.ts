import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  compileOperatorAgentRegistry,
  type CompiledOperatorAgentRegistry,
} from "../operator-control/agent-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveConfiguredAgentWorkspaceDir } from "./agent-scope.js";
import {
  isRuntimePathMapped,
  translateContainerPathToHostPath,
} from "./sandbox/runtime-path-map.js";

export type SubagentTargetReadinessStatus =
  | "ready"
  | "missing_config"
  | "missing_workspace"
  | "stale_allowlist";

export type SubagentTargetReadiness = {
  agentId: string;
  requesterAgentId?: string;
  status: SubagentTargetReadinessStatus;
  configured: boolean;
  registryKnown: boolean;
  workspaceDir?: string;
  hostWorkspaceDir?: string;
  promptPath?: string;
  runtimeMapped: boolean;
  reasons: string[];
};

export type SubagentAllowlistAuditEntry = SubagentTargetReadiness & {
  scopePath: string;
};

function loadRegistrySafely(): CompiledOperatorAgentRegistry | undefined {
  try {
    return compileOperatorAgentRegistry();
  } catch {
    return undefined;
  }
}

function hasRegistryAgentRecord(
  registry: CompiledOperatorAgentRegistry | undefined,
  agentId: string,
): boolean {
  return Boolean(
    registry?.agents.some((entry) => normalizeAgentId(entry.id) === normalizeAgentId(agentId)),
  );
}

function buildWorkspaceReadiness(params: {
  agentId: string;
  requesterAgentId?: string;
  status: SubagentTargetReadinessStatus;
  configured: boolean;
  registryKnown: boolean;
  workspaceDir?: string;
  hostWorkspaceDir?: string;
  promptPath?: string;
  runtimeMapped: boolean;
  reasons: string[];
}): SubagentTargetReadiness {
  return {
    agentId: normalizeAgentId(params.agentId),
    requesterAgentId: params.requesterAgentId
      ? normalizeAgentId(params.requesterAgentId)
      : undefined,
    status: params.status,
    configured: params.configured,
    registryKnown: params.registryKnown,
    workspaceDir: params.workspaceDir,
    hostWorkspaceDir: params.hostWorkspaceDir,
    promptPath: params.promptPath,
    runtimeMapped: params.runtimeMapped,
    reasons: params.reasons,
  };
}

export function resolveConfiguredSubagentTargetReadiness(
  cfg: OpenClawConfig,
  targetAgentId: string,
  registry: CompiledOperatorAgentRegistry | undefined = loadRegistrySafely(),
): SubagentTargetReadiness {
  const normalizedTargetId = normalizeAgentId(targetAgentId);
  const registryKnown = hasRegistryAgentRecord(registry, normalizedTargetId);
  const workspaceDir = resolveConfiguredAgentWorkspaceDir(cfg, normalizedTargetId);
  if (!workspaceDir) {
    return buildWorkspaceReadiness({
      agentId: normalizedTargetId,
      status: "missing_config",
      configured: false,
      registryKnown,
      runtimeMapped: false,
      reasons: ["target agent is not explicitly configured in agents.list"],
    });
  }

  const runtimeMapped = isRuntimePathMapped(workspaceDir);
  const hostWorkspaceDir = translateContainerPathToHostPath(workspaceDir);
  // Check container path first (works inside Docker), then fall back to
  // translated host path (works on host / in tests where container paths
  // like /agent-homes/* don't exist on the local filesystem).
  const containerPromptPath = path.join(workspaceDir, "AGENTS.md");
  const hostPromptPath = path.join(hostWorkspaceDir, "AGENTS.md");
  const reasons: string[] = [];
  if (!runtimeMapped) {
    reasons.push("workspace does not resolve through the runtime path map");
  }
  // Agents with skipBootstrap: true intentionally skip workspace file seeding.
  // Do not flag missing AGENTS.md as a readiness failure for those agents.
  const targetEntry = cfg.agents?.list?.find((a) => normalizeAgentId(a.id) === normalizedTargetId);
  const targetSkipsBootstrap = targetEntry?.skipBootstrap === true;
  if (
    !targetSkipsBootstrap &&
    !fs.existsSync(containerPromptPath) &&
    !fs.existsSync(hostPromptPath)
  ) {
    reasons.push("workspace is missing AGENTS.md");
  }
  return buildWorkspaceReadiness({
    agentId: normalizedTargetId,
    status: reasons.length === 0 ? "ready" : "missing_workspace",
    configured: true,
    registryKnown,
    workspaceDir,
    hostWorkspaceDir,
    promptPath: hostPromptPath,
    runtimeMapped,
    reasons,
  });
}

export function resolveSubagentTargetReadiness(params: {
  cfg: OpenClawConfig;
  requesterAgentId?: string;
  targetAgentId: string;
  classifyStaleAllowlist?: boolean;
  registry?: CompiledOperatorAgentRegistry;
}): SubagentTargetReadiness {
  const registry = params.registry ?? loadRegistrySafely();
  const configured = resolveConfiguredSubagentTargetReadiness(
    params.cfg,
    params.targetAgentId,
    registry,
  );
  if (configured.status !== "missing_config") {
    return buildWorkspaceReadiness({
      ...configured,
      requesterAgentId: params.requesterAgentId,
    });
  }

  return buildWorkspaceReadiness({
    agentId: params.targetAgentId,
    requesterAgentId: params.requesterAgentId,
    status: params.classifyStaleAllowlist ? "stale_allowlist" : "missing_config",
    configured: false,
    registryKnown: configured.registryKnown,
    runtimeMapped: false,
    reasons: [
      params.classifyStaleAllowlist
        ? "allowlist entry has no matching explicit agents.list runtime"
        : "target agent is not explicitly configured in agents.list",
    ],
  });
}

export function collectSubagentAllowlistAudit(
  cfg: OpenClawConfig,
  registry: CompiledOperatorAgentRegistry | undefined = loadRegistrySafely(),
): SubagentAllowlistAuditEntry[] {
  const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const audits: SubagentAllowlistAuditEntry[] = [];
  for (const entry of entries) {
    if (!entry?.id || !Array.isArray(entry.subagents?.allowAgents)) {
      continue;
    }
    const requesterAgentId = normalizeAgentId(entry.id);
    for (const rawTargetId of entry.subagents.allowAgents) {
      const trimmed = String(rawTargetId ?? "").trim();
      if (!trimmed || trimmed === "*" || normalizeAgentId(trimmed) === requesterAgentId) {
        continue;
      }
      const readiness = resolveSubagentTargetReadiness({
        cfg,
        requesterAgentId,
        targetAgentId: trimmed,
        classifyStaleAllowlist: true,
        registry,
      });
      audits.push({
        ...readiness,
        scopePath: `agents.list.${requesterAgentId}.subagents.allowAgents`,
      });
    }
  }
  return audits;
}
