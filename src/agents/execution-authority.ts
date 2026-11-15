import { getGlobalHookRunnerRegistry } from "../plugins/hook-runner-global-state.js";
import { getToolHookMatcherScope } from "../plugins/hooks.js";
import { getTrustedToolPolicyMatcherScope } from "../plugins/trusted-tool-policy.js";
import type { ResolvedExecDefaults } from "./exec-defaults.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Only the surviving core executor can establish the Gateway-owned execution path. */
export function resolveGatewayExecAuthority(
  options: { unverifiedExecutionPolicy?: true } | undefined,
  coreTools: readonly AnyAgentTool[],
  callableTools: readonly AnyAgentTool[],
): "gateway-host" | undefined {
  return !options?.unverifiedExecutionPolicy &&
    callableTools.some((tool) => tool.name === "exec" && coreTools.includes(tool))
    ? "gateway-host"
    : undefined;
}

/** Settings and catalogs cannot certify an executor controlled by another policy engine. */
export function hasUnrestrictedGatewayExecution(params: {
  execAuthority: "gateway-host" | undefined;
  execPolicy: Pick<ResolvedExecDefaults, "effectiveHost" | "security" | "ask">;
  sandboxed?: boolean;
  workspaceOnly?: boolean;
}): boolean {
  return (
    params.execAuthority === "gateway-host" &&
    params.sandboxed !== true &&
    params.workspaceOnly !== true &&
    params.execPolicy.effectiveHost === "gateway" &&
    params.execPolicy.security === "full" &&
    params.execPolicy.ask === "off" &&
    !hasGatewayExecPolicyGate()
  );
}

function hasGatewayExecPolicyGate(): boolean {
  const registry = getGlobalHookRunnerRegistry();
  if (!registry) {
    return false;
  }
  // Use the execution owners' matcher semantics. An applicable callback may deny,
  // constrain, or require approval even when exec's own policy is full/off.
  return [
    getToolHookMatcherScope(registry, "before_tool_call"),
    getTrustedToolPolicyMatcherScope(registry),
  ].some((scope) => scope?.matchAll || scope?.toolNames.includes("exec"));
}
