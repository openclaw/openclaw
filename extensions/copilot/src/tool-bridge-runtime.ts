import type { Tool as SdkTool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import type {
  AgentHarnessHostCapabilities,
  AnyAgentTool,
  EmbeddedRunAttemptParamsV2,
  SandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildEmbeddedAttemptToolRunContext } from "openclaw/plugin-sdk/agent-harness-runtime";

type CreateOpenClawCodingTools =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
export type OpenClawCodingToolsOptions = NonNullable<Parameters<CreateOpenClawCodingTools>[0]>;
type CreateOpenClawCodingToolsForBridge = (
  options?: OpenClawCodingToolsOptions,
) => ReturnType<CreateOpenClawCodingTools> | Promise<ReturnType<CreateOpenClawCodingTools>>;

/**
 * Mutable holder populated by `attempt.ts` after SDK session creation or
 * resumption. The bridge is constructed earlier, but bridged tools cannot
 * execute before the session exists, so an absent current session is a no-op.
 */
interface CopilotSessionHolder {
  current: { abort?: () => unknown } | undefined;
}

/**
 * Structural subset of `EmbeddedRunAttemptParamsV2` carried into the tool
 * bridge for PI-parity tool context. Keeping the SDK contract here avoids an
 * `attempt.ts` to `tool-bridge.ts` import cycle.
 */
export type CopilotToolAttemptParams = Partial<
  Omit<EmbeddedRunAttemptParamsV2, "hostCapabilities">
> &
  Pick<EmbeddedRunAttemptParamsV2, "hostCapabilities">;

export type CopilotToolCompletion = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
};

type CopilotSuspendableToolCompletion = Omit<CopilotToolCompletion, "result"> & {
  providerResult: ToolResultObject;
  result: unknown;
};

export interface CopilotToolBridgeInput {
  allowModelTools?: boolean;
  /** Invalidates screenshot-bound computer actions after context compaction. */
  computerContextEpoch?: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  };
  modelProvider: string;
  modelId: string;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  cwd?: string;
  /**
   * Sandbox context resolved by the caller. Wrapped tools receive the same
   * sandbox-aware behavior as PI; null or omitted means sandbox is disabled.
   */
  sandbox?: SandboxContext | null;
  /**
   * Spawn workspace prepared by the attempt from the original workspace.
   * Undefined keeps normal workspace wiring for absent or rw sandboxes.
   */
  spawnWorkspaceDir: string | undefined;
  abortSignal?: AbortSignal;
  /**
   * Full attempt authority forwarded to tool construction and host wrappers.
   * Every constructed surface still requires the host-bound capability.
   */
  attemptParams: CopilotToolAttemptParams;
  sessionRef?: CopilotSessionHolder;
  /**
   * Routes sessions_yield to the live SDK session and records attempt
   * liveness; the bridge always aborts the current session as well.
   */
  onYieldDetected?: (message?: string, acknowledgment?: string) => void;
  onToolCompleted?: (completion: CopilotToolCompletion) => void | Promise<void>;
  onSuspendableToolCompleted?: (completion: CopilotSuspendableToolCompletion) => Promise<void>;
  createOpenClawCodingTools?: CreateOpenClawCodingToolsForBridge;
  beforeExecute?: (ctx: {
    toolName: string;
    toolCallId: string;
    args: unknown;
    sourceTool: AnyAgentTool;
    invocation: ToolInvocation;
  }) => void | Promise<void>;
}

export type CopilotPromptToolPolicyParams = {
  toolsAllow?: string[];
  forceToolNames?: readonly string[];
};

export type CopilotPromptToolPolicy = {
  requireExplicitMessageTarget?: boolean;
  apply: (params?: CopilotPromptToolPolicyParams) => {
    tools: SdkTool[];
    callableToolNames: string[];
  };
};

export interface CopilotToolBridge {
  cleanup?: () => void;
  codeModeEngaged?: boolean;
  promptToolPolicy: CopilotPromptToolPolicy;
  sourceTools: AnyAgentTool[];
}

export type ScheduleToolExecution = (
  executionMode: AnyAgentTool["executionMode"],
  execute: () => Promise<ToolResultObject>,
) => Promise<ToolResultObject>;

export const EMPTY_COPILOT_PROMPT_TOOL_POLICY: CopilotPromptToolPolicy = {
  apply: () => ({ tools: [], callableToolNames: [] }),
};

export function createCopilotToolExecutionScheduler(): ScheduleToolExecution {
  let sequentialBarrier = Promise.resolve();
  const pendingCalls = new Set<Promise<void>>();
  return (executionMode, execute) => {
    // SDK handlers arrive independently. An exclusive call waits for earlier
    // work across the attempt and blocks later calls, regardless of tool name.
    const ready = executionMode === "sequential" ? Promise.all(pendingCalls) : sequentialBarrier;
    const run = ready.then(execute);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    pendingCalls.add(settled);
    void settled.then(() => pendingCalls.delete(settled));
    if (executionMode === "sequential") {
      sequentialBarrier = settled;
    }
    return run;
  };
}

export function createCopilotPromptToolPolicy(params: {
  attemptParams: Parameters<typeof buildEmbeddedAttemptToolRunContext>[0];
  basePolicy: {
    apply: (input?: CopilotPromptToolPolicyParams) => {
      tools: Array<{ name: string }>;
      callableToolNames: string[];
    };
  };
  codeModeControlsEnabled: boolean;
  forceMessageTool: boolean;
  providerTranscriptCommit: AgentHarnessHostCapabilities["commitProviderTranscriptPrefix"];
  requireExplicitMessageTarget?: boolean;
  sdkTools: readonly SdkTool[];
}): CopilotPromptToolPolicy {
  return {
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    apply: (input = {}) => {
      const result = params.basePolicy.apply({
        ...input,
        toolsAllow: buildEmbeddedAttemptToolRunContext({
          ...params.attemptParams,
          toolsAllow: input.toolsAllow,
          forceMessageTool: params.forceMessageTool,
        }).runtimeToolAllowlist,
      });
      const directToolNames = new Set(result.tools.map((tool) => tool.name));
      const tools = params.sdkTools.filter((tool) => directToolNames.has(tool.name));
      // Gate the final prompt surface: before_prompt_build may remove every
      // Code Mode control, in which case an older host cannot dispatch one.
      const requiresProviderTranscriptCommit =
        params.codeModeControlsEnabled &&
        tools.some((tool) => tool.name === "exec" || tool.name === "wait");
      if (requiresProviderTranscriptCommit && !params.providerTranscriptCommit) {
        throw new Error(
          "Copilot Code Mode requires host provider transcript commit capability; upgrade OpenClaw or disable Code Mode.",
        );
      }
      return { tools, callableToolNames: result.callableToolNames };
    },
  };
}
