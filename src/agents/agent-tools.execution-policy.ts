import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { resolveExecDefaults } from "./exec-defaults.js";
import type { projectEffectiveExecPolicy } from "./session-permission-exec-mode.js";

/** Browser previews inherit only existing unrestricted execution on this host. */
export function resolveLocalBrowserLoopbackCapability(params: {
  options?: OpenClawCodingToolsOptions;
  execApprovals?: ExecApprovalsFile;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  effectiveExecPolicy: ReturnType<typeof projectEffectiveExecPolicy>;
  sandboxed: boolean;
  workspaceOnly: boolean;
}): boolean {
  const { options, capabilityProfile, effectiveExecPolicy, sandboxed, workspaceOnly } = params;
  // Native harnesses may own the shell surface, so check policy, not tool materialization.
  if (sandboxed || workspaceOnly || !isConversationToolAllowed(capabilityProfile, "exec")) {
    return false;
  }
  const sessionPermissionPolicy = options?.sessionPermissionPolicy;
  const localExec = resolveExecDefaults({
    cfg: options?.config,
    execApprovals: params.execApprovals,
    agentId: capabilityProfile.policy.agentId,
    sessionKey: options?.sessionKey,
    sandboxAvailable: false,
    sessionEntry: sessionPermissionPolicy
      ? { permissionMode: sessionPermissionPolicy.mode }
      : undefined,
    execOverrides: effectiveExecPolicy,
  });
  return (
    localExec.effectiveHost === "gateway" &&
    localExec.security === "full" &&
    localExec.ask === "off"
  );
}
