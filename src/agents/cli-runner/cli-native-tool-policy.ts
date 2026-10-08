import { resolveSessionAgentIds } from "../agent-scope.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import { resolvePluginHarnessToolPolicies } from "../harness/execution-environment.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
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

export function resolveCliNativeToolPolicy(context: PreparedCliRunContext) {
  const run = context.params;
  const policySessionKey = run.runtimePolicySessionKey ?? run.sessionKey;
  const policyAgentId = resolveSessionAgentIds({
    sessionKey: policySessionKey,
    config: run.config,
    fallbackAgentId: run.agentId,
  }).sessionAgentId;
  const permission = resolveExecDefaults({
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
    preparedSessionEntry: run.sessionEntry,
  });
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
    fsWorkspaceOnly: resolveEffectiveToolFsWorkspaceOnly({
      cfg: run.config,
      agentId: policyAgentId,
    }),
  };
}
