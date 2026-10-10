import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveUserPath } from "../../../utils.js";
import { listAgentIds, resolveAgentConfig } from "../../agent-scope-config.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
  shouldInheritSubagentToolPolicy,
} from "../../inherited-tool-deny.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { resolveSpawnSandboxError } from "../../spawn-plan.js";
import { resolveSenderRestrictedSpawnError } from "../../spawn-requester-policy.js";
import type { SpawnedToolContext } from "../../spawned-context.js";
import { resolveSubagentTargetPolicy } from "./subagent-target-policy.js";

export function resolveAcpSpawnToolPolicy(
  params: Pick<
    SpawnedToolContext,
    "inheritedToolPolicySource" | "inheritedToolAllowlist" | "inheritedToolDenylist"
  > & { cfg: OpenClawConfig; requesterAgentId: string; ownerAgentId: string },
):
  | { ok: true; inheritedToolAllowlist?: string[]; inheritedToolDenylist?: string[] }
  | { ok: false; errorCode: "subagent_policy" | "runtime_policy"; error: string } {
  const inheritToolPolicy = shouldInheritSubagentToolPolicy({
    requesterAgentId: params.requesterAgentId,
    targetAgentId: params.ownerAgentId,
    inheritedToolPolicySource: params.inheritedToolPolicySource,
  });
  if (
    !inheritToolPolicy &&
    (params.inheritedToolAllowlist?.length || params.inheritedToolDenylist?.length)
  ) {
    const targetPolicy = resolveSubagentTargetPolicy({
      requesterAgentId: params.requesterAgentId,
      targetAgentId: params.ownerAgentId,
      requestedAgentId: params.ownerAgentId,
      allowAgents:
        resolveAgentConfig(params.cfg, params.requesterAgentId)?.subagents?.allowAgents ??
        params.cfg.agents?.defaults?.subagents?.allowAgents,
      configuredAgentIds: listAgentIds(params.cfg),
    });
    if (!targetPolicy.ok) {
      return { ok: false, errorCode: "subagent_policy", error: targetPolicy.error };
    }
  }
  const inheritedToolAllowlist = inheritToolPolicy ? params.inheritedToolAllowlist : undefined;
  const inheritedToolDenylist = inheritToolPolicy ? params.inheritedToolDenylist : undefined;
  const unsupportedDeny = findAcpUnsupportedInheritedToolDeny(inheritedToolDenylist);
  if (unsupportedDeny) {
    return {
      ok: false,
      errorCode: "runtime_policy",
      error: formatAcpInheritedToolDenyError(unsupportedDeny),
    };
  }
  const unsupportedAllow = findAcpUnsupportedInheritedToolAllow(inheritedToolAllowlist);
  if (unsupportedAllow) {
    return {
      ok: false,
      errorCode: "runtime_policy",
      error: formatAcpInheritedToolAllowError(unsupportedAllow),
    };
  }
  return { ok: true, inheritedToolAllowlist, inheritedToolDenylist };
}

export function resolveAcpSpawnRuntimePolicyError(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
  sandbox?: "inherit" | "require";
}): string | undefined {
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
    agentId: params.requesterAgentId,
  });
  return resolveSpawnSandboxError({
    backend: "acp",
    requesterSandboxed: params.requesterSandboxed === true || requesterRuntime.sandboxed,
    sandbox: params.sandbox === "require" ? "require" : "inherit",
  });
}

export function resolveAcpSenderSpawnError(
  params: Pick<
    SpawnedToolContext,
    "inheritedToolPolicySource" | "workspaceDir" | "sessionPermissionPolicy"
  > & { requesterAgentId: string; targetAgentId: string; cwd?: string },
): string | undefined {
  const targetError = resolveSenderRestrictedSpawnError(params);
  if (targetError) {
    return targetError;
  }
  if (params.inheritedToolPolicySource !== "sender") {
    return undefined;
  }
  const root = params.sessionPermissionPolicy?.root ?? params.workspaceDir;
  return (params.sessionPermissionPolicy && params.sessionPermissionPolicy.mode !== "full") ||
    !root ||
    (params.cwd && resolveUserPath(params.cwd) !== resolveUserPath(root))
    ? `ACP cannot preserve this sender's session root restrictions. Use runtime="subagent" without a cwd override.`
    : undefined;
}
