import crypto from "node:crypto";
import {
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveChildAdmission, type ChildAdmissionCap } from "./child-admission.js";
import { countActiveRunsForSession } from "./subagents/registry/subagent-registry.js";
import { resolveSubagentCapabilities } from "./subagents/spawn/subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagents/spawn/subagent-depth.js";
import { resolveSubagentTargetPolicy } from "./subagents/spawn/subagent-target-policy.js";

type SpawnBackendKind = "subagent" | "acp";

export function mintSpawnSessionKey(params: {
  targetAgentId: string;
  backend: SpawnBackendKind;
}): string {
  const kind = params.backend === "acp" ? "acp" : "subagent";
  return `agent:${params.targetAgentId}:${kind}:${crypto.randomUUID()}`;
}

export function resolveSpawnAdmission(params: {
  cfg: OpenClawConfig;
  enabled?: boolean;
  collector?: {
    liveChildren: number;
    totalChildren: number;
    maxChildrenPerGroup: number;
    maxTotalPerGroup: number;
  };
  requesterSessionKey: string;
  requesterAgentId: string;
  targetAgentId: string;
  requestedAgentId?: string;
  configuredAgentIds: string[];
  additionalActiveChildren?: number;
}):
  | {
      ok: true;
      maxSpawnDepth?: number;
      childSessionPatch?: {
        spawnDepth: number;
        subagentRole: "orchestrator" | "leaf" | null;
        subagentControlScope: "children" | "none";
      };
    }
  | { ok: false; governingCap?: ChildAdmissionCap; error: string } {
  if (params.enabled === false) {
    return { ok: true };
  }
  const callerDepth = getSubagentDepthFromSessionStore(params.requesterSessionKey, {
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  const maxSpawnDepth =
    params.cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const collector = params.collector;
  // Build each mode's params in its own branch so collector counts can never
  // pair with the announce cap (or vice versa) through fallback chaining.
  const childAdmission = collector
    ? resolveChildAdmission({
        callerDepth,
        maxSpawnDepth,
        collect: true,
        activeChildren: collector.liveChildren,
        maxActiveChildren: collector.maxChildrenPerGroup,
        totalChildren: collector.totalChildren,
        maxTotalChildren: collector.maxTotalPerGroup,
      })
    : resolveChildAdmission({
        callerDepth,
        maxSpawnDepth,
        collect: false,
        activeChildren:
          countActiveRunsForSession(params.requesterSessionKey, {
            collect: false,
            requesterAgentId: params.requesterAgentId,
          }) + (params.additionalActiveChildren ?? 0),
        maxActiveChildren:
          params.cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ??
          DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
      });
  if (!childAdmission.ok) {
    return childAdmission;
  }
  const requesterSubagentConfig = resolveAgentConfig(
    params.cfg,
    params.requesterAgentId,
  )?.subagents;
  const requireAgentId =
    requesterSubagentConfig?.requireAgentId ??
    params.cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !params.requestedAgentId?.trim()) {
    return {
      ok: false,
      error:
        "sessions_spawn requires explicit agentId when requireAgentId is configured. Provide an allowed configured agentId.",
    };
  }
  const targetPolicy = resolveSubagentTargetPolicy({
    requesterAgentId: params.requesterAgentId,
    targetAgentId: params.targetAgentId,
    requestedAgentId: params.requestedAgentId,
    allowAgents:
      requesterSubagentConfig?.allowAgents ?? params.cfg.agents?.defaults?.subagents?.allowAgents,
    configuredAgentIds: params.configuredAgentIds,
  });
  if (!targetPolicy.ok) {
    return { ok: false, error: targetPolicy.error };
  }
  const capabilities = resolveSubagentCapabilities({
    depth: callerDepth + 1,
    maxSpawnDepth,
  });
  return {
    ok: true,
    maxSpawnDepth,
    childSessionPatch: {
      spawnDepth: capabilities.depth,
      subagentRole: capabilities.role === "main" ? null : capabilities.role,
      subagentControlScope: capabilities.controlScope,
    },
  };
}

export function resolveSpawnSandboxError(
  params:
    | {
        backend: "acp";
        requesterSandboxed: boolean;
        sandbox: "inherit" | "require";
      }
    | {
        backend: "subagent";
        requesterSandboxed: boolean;
        childSandboxed: boolean;
        sandbox: "inherit" | "require";
      },
): string | undefined {
  if (params.backend === "acp") {
    if (params.requesterSandboxed) {
      return 'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.';
    }
    return params.sandbox === "require"
      ? 'sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".'
      : undefined;
  }
  if (params.childSandboxed || (!params.requesterSandboxed && params.sandbox !== "require")) {
    return undefined;
  }
  return params.requesterSandboxed
    ? "Sandboxed sessions cannot spawn unsandboxed subagents. Set a sandboxed target agent or use the same agent runtime."
    : 'sessions_spawn sandbox="require" needs a sandboxed target runtime. Pick a sandboxed agentId or use sandbox="inherit".';
}
