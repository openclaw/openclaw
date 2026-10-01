import type { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import { readAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { admitCliRunParams } from "./run-admission.js";
import type { RunCliAgentParams } from "./types.js";

type ResolveMcpTools = typeof resolveMcpLoopbackScopedTools;
type McpScope = Parameters<ResolveMcpTools>[0];

/** Project the CLI tool surface before prompt construction, retaining its exact run admission. */
export async function prepareCliMcpToolProjection(
  params: RunCliAgentParams,
  options: {
    agentId: string;
    context: McpScope["context"];
    runtimeToolsAllowPolicy?: string[];
    rootedToolsAllow?: string[];
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
    signal: admittedParams.abortSignal,
    context,
    admittedRunContext: admittedParams.admittedRunContext,
    sessionControlAuthority: readAdmittedRunOperatorAuthority(admittedParams.admittedRunContext),
  });
  return { params: admittedParams, tools };
}
