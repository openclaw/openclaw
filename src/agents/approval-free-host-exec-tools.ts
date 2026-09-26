import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { withCommandExecutionAuthority } from "../process/command-execution-authority.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { hasApprovalFreeHostExecAuthority } from "./approval-free-host-exec-authority.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import type { projectEffectiveExecPolicy } from "./session-permission-exec-mode.js";

type EffectiveExecPolicy = ReturnType<typeof projectEffectiveExecPolicy>;

const APPROVAL_FREE_HOST_EXEC_FALLBACK = Symbol.for(
  "openclaw.internal.approvalFreeHostExecFallback",
);

function getApprovalFreeHostExecFallback(tool: AnyAgentTool): AnyAgentTool | undefined {
  // SAFETY: Only this bundled integration writes the private symbol, and it stores an AnyAgentTool.
  return Reflect.get(tool, APPROVAL_FREE_HOST_EXEC_FALLBACK) as AnyAgentTool | undefined;
}

export function createHostExecAuthority(params: {
  agentId?: string;
  includeShellTools: boolean;
  sandboxed: boolean;
  policy: EffectiveExecPolicy;
}): () => boolean {
  return () =>
    params.includeShellTools &&
    !params.sandboxed &&
    (params.policy.host === undefined ||
      params.policy.host === "auto" ||
      params.policy.host === "gateway") &&
    hasApprovalFreeHostExecAuthority({
      agentId: params.agentId,
      mode: params.policy.mode,
      security: params.policy.security,
      ask: params.policy.ask,
      bypassHostApprovalFloors: params.policy.bypassHostApprovalFloors,
    });
}

export function pinScheduledExecTool(
  tools: AnyAgentTool[],
  target: ScheduledToolPolicyContext["execTarget"] | undefined,
): AnyAgentTool[] {
  if (!target) {
    return tools;
  }
  return tools.map((tool) =>
    tool.name === "exec" ? copyAgentToolMetadata(tool, pinExecToolTarget(tool, target)) : tool,
  );
}

export function projectHostExecTools(
  tools: AnyAgentTool[],
  hasAuthority: () => boolean,
): AnyAgentTool[] {
  const approvalFreeExecRetained = hasAuthority() && tools.some((tool) => tool.name === "exec");
  return tools.flatMap((tool) => {
    const fallback = getApprovalFreeHostExecFallback(tool);
    if (!fallback) {
      return [tool];
    }
    if (approvalFreeExecRetained) {
      return [
        copyAgentToolMetadata(tool, {
          ...tool,
          execute: async (toolCallId, params, signal, onUpdate) => {
            const assertAuthority = () => {
              if (!hasAuthority()) {
                throw new Error("tool denied: approval-free host exec authority was revoked");
              }
            };
            return await withCommandExecutionAuthority(assertAuthority, () =>
              tool.execute(toolCallId, params, signal, onUpdate),
            );
          },
        }),
      ];
    }
    if (!fallback || fallback.name !== tool.name || !getPluginToolMeta(tool)) {
      return [];
    }
    return [copyAgentToolMetadata(tool, fallback)];
  });
}
