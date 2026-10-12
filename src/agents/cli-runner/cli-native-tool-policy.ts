import { resolveSessionAgentIds } from "../agent-scope.js";
import { resolveExecDefaultsAsync } from "../exec-defaults.js";
import { resolvePluginHarnessToolPolicies } from "../harness/execution-environment.js";
import { resolveSessionPermissionCoreToolPolicy } from "../session-permission-exec-mode.js";
import {
  resolveEffectiveToolFsWorkspaceOnly,
  resolveStoredSessionPermissionPolicy,
} from "../tool-fs-policy.js";
import { normalizeCliToolName } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

export function resolveCliNativeToolPolicyName(
  context: PreparedCliRunContext,
  toolName: string,
): { nativeToolName: string; canonicalToolName: string } {
  const nativeToolName = normalizeCliToolName(toolName);
  const projectedCapabilities = context.backendResolved.projectNativeToolAuthority?.([toolName]);
  return {
    nativeToolName,
    canonicalToolName:
      projectedCapabilities?.length === 1
        ? normalizeCliToolName(projectedCapabilities[0] ?? "")
        : nativeToolName,
  };
}

export async function resolveCliNativeToolPolicy(context: PreparedCliRunContext) {
  const run = context.params;
  const policySessionKey = run.runtimePolicySessionKey ?? run.sessionKey;
  const policyAgentId = resolveSessionAgentIds({
    sessionKey: policySessionKey,
    config: run.config,
    fallbackAgentId: run.agentId,
  }).sessionAgentId;
  const permission = await resolveExecDefaultsAsync({
    cfg: run.config,
    sessionEntry: run.sessionEntry,
    execOverrides: run.execOverrides,
    agentId: policyAgentId,
    sessionKey: policySessionKey,
  });
  const toolPolicies = resolvePluginHarnessToolPolicies({
    ...run,
    agentId: policyAgentId,
    sessionKey: policySessionKey,
    sandboxSessionKey: policySessionKey,
    sandboxAgentId: policyAgentId,
    provider: run.modelProvider ?? run.provider,
    modelId: context.modelId,
    // The admitted run's session facts are authoritative, including absence:
    // a run without a sessionEntry has no stored entry for the policy session,
    // so acknowledge the absence instead of falling through to a synchronous
    // session-store read on the gateway thread.
    preparedSessionEntry: run.sessionEntry ?? null,
  });
  // One harness-independent session posture: an explicit session permission
  // mode governs filesystem permissions — an explicit full session stays
  // unrestricted by configured containment, and bounded modes keep containment
  // at their recorded root. Configuration is only the fallback when the
  // admitted session records no mode.
  const sessionPermissionPolicy = resolveStoredSessionPermissionPolicy(
    run.sessionEntry,
    context.workspaceDir,
  );
  const sessionFsPolicy = sessionPermissionPolicy
    ? resolveSessionPermissionCoreToolPolicy(sessionPermissionPolicy)
    : undefined;
  return {
    permission,
    policySessionKey,
    policyAgentId,
    effectiveToolPolicies: [
      toolPolicies.senderPolicy,
      toolPolicies.senderScopedGroupPolicy,
      toolPolicies.groupPolicy,
      ...toolPolicies.runtimePolicies,
    ],
    fsWorkspaceOnly:
      sessionFsPolicy?.workspaceOnly ??
      resolveEffectiveToolFsWorkspaceOnly({
        cfg: run.config,
        agentId: policyAgentId,
      }),
    fsRoot: sessionPermissionPolicy?.root ?? context.workspaceDir,
  };
}
