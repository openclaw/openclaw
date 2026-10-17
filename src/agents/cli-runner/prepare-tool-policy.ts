import type { ResolvedCliBackend } from "../cli-backends.js";
import { prepareConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

/**
 * Translate the caller's runtime tool cap into the CLI run's exact tool availability.
 * Native CLI tools cannot enforce workspace, channel, or inherited completion caps, so those
 * runs expose their whole surface through the mediated MCP policy projection.
 */
export async function resolveCliRuntimeToolPolicy(input: {
  params: RunCliAgentParams;
  policySessionKey: string | undefined;
  policyAgentId: string;
  backendId: string;
  bundleMcp: boolean;
  canEnforceExactToolAvailability: boolean;
  projectNativeToolAuthority?: ResolvedCliBackend["projectNativeToolAuthority"];
  sideQuestionToolMode?: ResolvedCliBackend["sideQuestionToolMode"];
  isSideQuestion: boolean;
  skipsTurnPreparation: boolean;
}): Promise<{ params: RunCliAgentParams; runtimeToolsAllowPolicy: string[] | undefined }> {
  let { params } = input;
  let runtimeToolsAllowPolicy: string[] | undefined;
  if (params.toolsAllow !== undefined) {
    if (params.cliToolAvailability !== undefined) {
      throw new Error(`CLI backend ${input.backendId} received conflicting runtime tool policies`);
    }
    if (params.toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")) {
      params = { ...params, toolsAllow: undefined };
    } else {
      runtimeToolsAllowPolicy = [...params.toolsAllow];
      const fallbackOpenClawTools = expandToolGroups(params.toolsAllow);
      if (
        fallbackOpenClawTools.includes("write") &&
        !fallbackOpenClawTools.includes("apply_patch")
      ) {
        fallbackOpenClawTools.push("apply_patch");
      }
      params = {
        ...params,
        toolsAllow: undefined,
        cliToolAvailability: {
          native: [],
          // Preserve the prior normalized fallback for modes without a catalog;
          // catalog-backed paths replace it with exact names below.
          openClaw: fallbackOpenClawTools,
        },
      };
    }
  }
  if (
    params.disableTools === true &&
    !input.isSideQuestion &&
    input.canEnforceExactToolAvailability
  ) {
    // Selectable backends need the exact empty cap as well as the generic flag;
    // otherwise their native tools remain selectable and the run must fail closed.
    runtimeToolsAllowPolicy = undefined;
    params = {
      ...params,
      toolsAllow: undefined,
      cliToolAvailability: { native: [], openClaw: [] },
    };
  }
  const requesterSessionKey = params.sessionKey ?? input.policySessionKey;
  // Completion turns already require mediation. Ordinary resumes must derive the
  // same restriction from the admitted child's policy, without guessing its sender.
  const requesterPolicy =
    params.disableTools === true || params.trustedInternalHandoff
      ? undefined
      : (
          await prepareConversationCapabilityProfile({
            ...params,
            agentId: input.policyAgentId,
            sessionKey: input.policySessionKey,
            sandboxSessionKey: requesterSessionKey,
            preparedSessionEntry:
              params.sessionEntry && requesterSessionKey
                ? { sessionKey: requesterSessionKey, entry: params.sessionEntry }
                : undefined,
            modelProvider: params.modelProvider ?? params.provider,
            modelId: params.model,
          })
        ).policy;
  const senderRestricted = requesterPolicy?.inheritedToolPolicySource === "sender";
  const delegatedExecution = Boolean(requesterPolicy?.delegatedToolPolicy);
  // Internal controls and backend-enforced tool-free questions have no file authority.
  const workspaceOnly =
    params.controlOperation === undefined &&
    !(input.isSideQuestion && input.sideQuestionToolMode === "disabled") &&
    resolveEffectiveToolFsWorkspaceOnly({ cfg: params.config, agentId: input.policyAgentId });
  if (
    (params.trustedInternalHandoff || senderRestricted || delegatedExecution || workspaceOnly) &&
    params.disableTools !== true
  ) {
    if (
      !input.canEnforceExactToolAvailability ||
      !input.bundleMcp ||
      input.skipsTurnPreparation ||
      params.sessionEntry?.execHost === "node" ||
      params.trustedInternalHandoff?.settleBatch !== undefined
    ) {
      throw new Error(
        `CLI backend ${input.backendId} cannot enforce ${senderRestricted ? "conversation" : delegatedExecution ? "delegated execution" : params.trustedInternalHandoff ? "completion" : "workspace-only"} tool policy`,
      );
    }
    const exactWorkspaceTools =
      workspaceOnly && params.cliToolAvailability && runtimeToolsAllowPolicy === undefined
        ? [
            ...params.cliToolAvailability.openClaw,
            ...(input.projectNativeToolAuthority?.(params.cliToolAvailability.native) ?? []),
          ]
        : undefined;
    // Exact selections must bypass policy expansion (for example, write -> apply_patch).
    if (exactWorkspaceTools === undefined) {
      runtimeToolsAllowPolicy ??= senderRestricted
        ? (params.cliToolAvailability?.openClaw ?? ["*"])
        : ["*"];
    }
    params = {
      ...params,
      toolsAllow: undefined,
      cliToolAvailability: { native: [], openClaw: exactWorkspaceTools ?? [] },
    };
  }
  return { params, runtimeToolsAllowPolicy };
}
