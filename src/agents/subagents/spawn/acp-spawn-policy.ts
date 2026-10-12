import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { resolveSpawnSandboxError } from "../../spawn-plan.js";
import { resolveSenderRestrictedSpawnError } from "../../spawn-requester-policy.js";
import type { SpawnedToolContext } from "../../spawned-context.js";

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
