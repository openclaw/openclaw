import type { McpLoopbackRequestContext } from "../../gateway/mcp-grant-store.js";
import type { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { resolveExecConfigState } from "../exec-defaults.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import { finalizeCliMcpGrant } from "./mcp-grant-context.js";
import { projectNativeMcpRunContext } from "./native-mcp-context.js";
import { admitCliRunParams } from "./run-admission.js";
import type { RunCliAgentParams } from "./types.js";

type ResolveMcpTools = typeof resolveMcpLoopbackScopedTools;
type McpScope = Parameters<ResolveMcpTools>[0];

/** Project native MCP from the same requester and runtime cap as mediated tools. */
export function resolveCliNativeMcpPolicy(
  run: RunCliAgentParams,
  options: {
    config: McpScope["cfg"];
    policySessionKey: string | undefined;
    policyAgentId: string;
    modelProvider: string;
    modelId: string;
    workspaceDir: string;
    cwd: string;
    runtimeToolsAllowPolicy?: string[];
  },
) {
  const requesterSessionKey = run.sessionKey ?? options.policySessionKey;
  const sandboxStatus = resolveSandboxRuntimeStatus({
    cfg: options.config,
    sessionKey: options.policySessionKey,
    agentId: options.policyAgentId,
  });
  const capabilityProfile = resolveConversationCapabilityProfile({
    ...projectNativeMcpRunContext(run),
    config: options.config,
    sessionKey: options.policySessionKey,
    sandboxSessionKey: requesterSessionKey,
    preparedSessionEntry:
      run.sessionEntry && requesterSessionKey
        ? { sessionKey: requesterSessionKey, entry: run.sessionEntry }
        : undefined,
    runSessionKey:
      run.sessionKey && run.sessionKey !== options.policySessionKey ? run.sessionKey : undefined,
    agentId: options.policyAgentId,
    modelProvider: options.modelProvider,
    modelId: options.modelId,
    workspaceDir: options.workspaceDir,
    cwd: options.cwd,
    sandboxToolPolicy: sandboxStatus.sandboxed ? sandboxStatus.toolPolicy : undefined,
    runtimeToolAllowlist: options.runtimeToolsAllowPolicy,
    inheritRuntimeToolAllowlist: true,
  });
  return { capabilityProfile, sandboxStatus };
}

/** Project the CLI tool surface before prompt construction, retaining its exact run admission. */
export async function prepareCliMcpToolProjection(
  params: RunCliAgentParams,
  options: {
    agentId: string;
    context: McpScope["context"];
    runtimeToolsAllowPolicy?: string[];
    rootedToolsAllow?: string[];
    defaultMediatedToolNames?: readonly string[];
    scope: Pick<
      McpScope,
      | "cfg"
      | "rootedExecution"
      | "skillLibraryAuthoring"
      | "authProfileStore"
      | "authProfileStoreAgentDir"
    >;
    resolvePolicyTools: ResolveMcpTools;
    resolveScopedTools: ResolveMcpTools;
  },
) {
  const requestedToolsAllow =
    options.runtimeToolsAllowPolicy ??
    (options.scope.rootedExecution
      ? options.rootedToolsAllow
      : params.cliToolAvailability?.openClaw);
  const context =
    requestedToolsAllow !== undefined
      ? { ...options.context, toolsAllow: [...requestedToolsAllow] }
      : options.context;
  const resolveTools =
    options.runtimeToolsAllowPolicy !== undefined ||
    (options.scope.rootedExecution && options.rootedToolsAllow === undefined)
      ? options.resolvePolicyTools
      : options.resolveScopedTools;
  const admittedParams = await admitCliRunParams(params, options.agentId);
  const { tools } = await resolveTools({
    ...options.scope,
    defaultMediatedToolNames: options.defaultMediatedToolNames,
    signal: admittedParams.abortSignal,
    context,
    admittedRunContext: admittedParams.admittedRunContext,
  });
  return { params: admittedParams, tools };
}

/** Resolve default coding ownership without changing exact, standalone, or node runs. */
export function resolveCliMcpToolOwnership(
  run: RunCliAgentParams,
  options: {
    backend: ResolvedCliBackend;
    enabled: boolean;
    nodePlacement: boolean;
    rooted: boolean;
    skipPreparation: boolean;
  },
) {
  const hostOwnedTools =
    options.enabled &&
    resolveExecConfigState({
      cfg: run.config,
      sessionEntry: run.sessionEntry,
      execOverrides: run.execOverrides,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
    }).host !== "node" &&
    !options.rooted &&
    run.cliToolAvailability === undefined &&
    options.backend.nativeToolMode === "selectable" &&
    options.backend.toolAvailabilityEnforcement === "execution-args" &&
    options.backend.resolveExecutionArgs !== undefined
      ? options.backend.hostOwnedTools?.map(normalizeToolPolicyName)
      : undefined;
  return {
    hostOwnedTools,
    nodeWorkshopEnabled:
      options.nodePlacement &&
      !options.skipPreparation &&
      run.disableTools !== true &&
      run.skillLibraryAuthoring !== undefined,
  };
}

/** Bind the projected catalog and native authority to one prepared CLI grant. */
export function prepareCliMcpGrant(
  run: RunCliAgentParams,
  options: {
    context: McpLoopbackRequestContext | undefined;
    tools: readonly { name: string }[];
    promptBuildRestrictsTools: boolean;
    hostOwnedTools?: readonly string[];
    nativeAuthorityAllowed: boolean;
    projectNativeToolAuthority: ResolvedCliBackend["projectNativeToolAuthority"];
  },
) {
  const exclusiveTools = run.cliToolAvailability !== undefined || options.promptBuildRestrictsTools;
  const toolsAllow =
    run.cliToolAvailability?.openClaw ??
    (exclusiveTools || options.hostOwnedTools !== undefined
      ? options.tools.map((tool) => tool.name)
      : undefined);
  const projectNativeToolAuthority =
    options.nativeAuthorityAllowed && run.disableTools !== true
      ? options.projectNativeToolAuthority
      : undefined;
  return {
    exclusiveTools,
    projectNativeToolAuthority,
    mcpGrant: finalizeCliMcpGrant(
      options.context,
      toolsAllow,
      Boolean(projectNativeToolAuthority),
      run,
    ),
  };
}
