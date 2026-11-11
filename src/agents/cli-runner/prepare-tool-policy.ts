import type { ResolvedCliBackend } from "../cli-backends.js";
import { hashCliSessionText } from "../cli-session.js";
import {
  prepareConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "../conversation-capability-profile.js";
import { isConversationToolAllowed } from "../conversation-tool-policy-pipeline.js";
import { applyEmbeddedAttemptToolsAllow } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { resolveExecConfigState } from "../exec-defaults.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";
import { resolveToolSearchConfig } from "../tool-search-config.js";
import { resolveCliNativeWebSearchEnabled } from "./bundle-mcp.js";
import type { RunCliAgentParams } from "./types.js";

/**
 * Translate the caller's runtime tool cap into the CLI run's exact tool availability.
 * Native CLI tools cannot enforce workspace, channel, or inherited completion caps, so those
 * runs expose their whole surface through the mediated MCP policy projection. Bundled
 * local Claude agent turns use that same mediated surface even without a cap, so a
 * completion does not replace the native tool prefix of a running session. Operator-selected
 * backend tools stay on both turn kinds for the same reason.
 */
export async function resolveCliRuntimeToolPolicy(input: {
  params: RunCliAgentParams;
  policySessionKey: string | undefined;
  policyAgentId: string;
  backendId: string;
  bundleMcp: boolean;
  canEnforceExactToolAvailability: boolean;
  projectNativeToolAuthority?: ResolvedCliBackend["projectNativeToolAuthority"];
  resolveManagedNativeTools?: ResolvedCliBackend["resolveManagedNativeTools"];
  sideQuestionToolMode?: ResolvedCliBackend["sideQuestionToolMode"];
  isSideQuestion: boolean;
  skipsTurnPreparation: boolean;
}): Promise<{
  params: RunCliAgentParams;
  runtimeToolsAllowPolicy: string[] | undefined;
  managedNativeTools: readonly string[];
}> {
  let { params } = input;
  let runtimeToolsAllowPolicy: string[] | undefined;
  let managedNativeTools: string[] = [];
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
  const ordinaryClaudeMediation =
    input.backendId === "claude-cli" &&
    input.bundleMcp &&
    input.canEnforceExactToolAvailability &&
    !input.isSideQuestion &&
    !input.skipsTurnPreparation &&
    params.sessionEntry?.execHost !== "node" &&
    params.cliToolAvailability === undefined &&
    resolveExecConfigState({
      cfg: params.config,
      sessionEntry: params.sessionEntry,
      execOverrides: params.execOverrides,
      agentId: input.policyAgentId,
      sessionKey: input.policySessionKey,
    }).host !== "node";
  if (
    (params.trustedInternalHandoff ||
      senderRestricted ||
      delegatedExecution ||
      workspaceOnly ||
      ordinaryClaudeMediation) &&
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
    // Only uncapped ordinary and verified completion turns reach this list, so both kinds
    // launch the same native surface. Restricted, delegated, and workspace-only runs keep none.
    managedNativeTools =
      params.cliToolAvailability === undefined &&
      !senderRestricted &&
      !delegatedExecution &&
      !workspaceOnly
        ? [
            ...(input.resolveManagedNativeTools?.({
              config: params.config,
              agentId: input.policyAgentId,
            }) ?? []),
          ]
        : [];
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
      cliToolAvailability: { native: managedNativeTools, openClaw: exactWorkspaceTools ?? [] },
    };
  }
  return { params, runtimeToolsAllowPolicy, managedNativeTools };
}

/**
 * Bootstrap routing needs the run's final file access: a native file-capable
 * selection, or Claude's mediated OpenClaw read plus write tools. Managed native
 * selections confer no file capability by backend contract.
 */
export function resolveCliBootstrapFileAccess(input: {
  backend: Pick<ResolvedCliBackend, "id" | "nativeToolMode">;
  params: Pick<RunCliAgentParams, "cliToolAvailability" | "disableTools">;
  managedNativeTools: readonly string[];
  projectedToolNames: readonly string[];
}): boolean {
  const { backend, params, managedNativeTools, projectedToolNames } = input;
  const selectedNativeToolsProvideFileAccess =
    params.cliToolAvailability === undefined ||
    params.cliToolAvailability.native.some((name) => !managedNativeTools.includes(name));
  const mediatedBootstrapFileAccess =
    backend.id === "claude-cli" &&
    projectedToolNames.includes("read") &&
    projectedToolNames.some((name) => ["write", "apply_patch"].includes(name));
  return (
    (((backend.nativeToolMode === "always-on" || backend.nativeToolMode === "selectable") &&
      selectedNativeToolsProvideFileAccess) ||
      mediatedBootstrapFileAccess) &&
    params.disableTools !== true
  );
}

/** Apply a `before_prompt_build` tool cap to both native and mediated CLI tools. */
export function capCliToolAvailability(
  params: RunCliAgentParams,
  toolsAllow: string[] | undefined,
): RunCliAgentParams {
  const availability = params.cliToolAvailability;
  if (!availability || toolsAllow === undefined) {
    return params;
  }
  const cap = (names: string[]) =>
    applyEmbeddedAttemptToolsAllow(
      names.map((name) => ({ name })),
      toolsAllow,
    ).map((tool) => tool.name);
  return {
    ...params,
    cliToolAvailability: {
      ...availability,
      native: cap(availability.native),
      openClaw: cap(availability.openClaw),
    },
  };
}

/**
 * Keep an operator-managed native tool only while the run's tool policy allows every
 * capability it confers (WebSearch confers web_search), so profile, agent, group, sender,
 * sandbox, and session policy cover the native tool too. Native search also follows the
 * CLI web-search rule. A capability that OpenClaw's own catalog already serves (a
 * configured search provider lists web_search) keeps priority, so the native duplicate is
 * dropped. Capability-free selections never resolve the policy profile.
 */
export async function retainPolicyAllowedManagedNativeTools(
  projection: { params: RunCliAgentParams; tools: readonly { name: string }[] },
  managedNativeTools: readonly string[],
  backend: Pick<ResolvedCliBackend, "bundleMcp" | "bundleMcpMode" | "projectNativeToolAuthority">,
  resolveCapabilityProfile: () => Promise<ResolvedConversationCapabilityProfile>,
): Promise<RunCliAgentParams> {
  const { params } = projection;
  const conferred = managedNativeTools.map(
    (name) => [name, backend.projectNativeToolAuthority?.([name]) ?? []] as const,
  );
  const availability = params.cliToolAvailability;
  if (!availability || conferred.every(([, capabilities]) => capabilities.length === 0)) {
    return params;
  }
  const nativeWebSearchEnabled = resolveCliNativeWebSearchEnabled(params, backend);
  const resolved = await resolveCapabilityProfile();
  // A completion checks its session's own inherited policy, not the requester cap, so it
  // launches the ordinary list; isCliNativeToolCallable refuses these calls on completions.
  const { policy } = resolved;
  const profile =
    policy.requesterPolicySource === "completion-handoff"
      ? {
          ...resolved,
          policy: { ...policy, inheritedToolPolicy: policy.sessionInheritedToolPolicy },
        }
      : resolved;
  const refused = new Set(
    conferred
      .filter(
        ([, capabilities]) =>
          !capabilities.every(
            (capability) =>
              (capability !== "web_search" || nativeWebSearchEnabled) &&
              !projection.tools.some((tool) => tool.name === capability) &&
              isConversationToolAllowed(profile, capability),
          ),
      )
      .map(([name]) => name),
  );
  const native = availability.native.filter((name) => !refused.has(name));
  return { ...params, cliToolAvailability: { ...availability, native } };
}

/** Operator-managed orchestration tools (no conferred capability) that survived every cap. */
export function keptManagedNativeTools(
  managedNativeTools: readonly string[],
  params: Pick<RunCliAgentParams, "cliToolAvailability">,
  backend: Pick<ResolvedCliBackend, "projectNativeToolAuthority">,
): string[] {
  return managedNativeTools.filter(
    (name) =>
      params.cliToolAvailability?.native.includes(name) &&
      !backend.projectNativeToolAuthority?.([name]).length,
  );
}

/** Discovery sees only the final MCP catalog and does not restore native execution tools. */
export function withCliToolSearch(
  params: RunCliAgentParams,
  nativeToolSearch: string | undefined,
): RunCliAgentParams {
  const availability = params.cliToolAvailability;
  if (
    !nativeToolSearch ||
    !availability ||
    params.disableTools ||
    availability.openClaw.length === 0 ||
    !resolveToolSearchConfig(params.config).enabled
  ) {
    return params;
  }
  return {
    ...params,
    cliToolAvailability: { ...availability, discovery: [nativeToolSearch] },
  };
}

/** Bind CLI session reuse to its stable native, discovery, and mediated tool catalog. */
export function resolveCliToolAvailabilityHash(
  baseHash: string | undefined,
  availability: RunCliAgentParams["cliToolAvailability"],
): string | undefined {
  return availability
    ? hashCliSessionText(
        JSON.stringify([
          baseHash ?? null,
          availability.native.toSorted(),
          availability.openClaw.toSorted(),
          ...(availability.discovery ? [availability.discovery] : []),
        ]),
      )
    : baseHash;
}
