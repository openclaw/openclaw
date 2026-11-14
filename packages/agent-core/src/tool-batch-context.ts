import type { AssistantMessage } from "@openclaw/llm-core";
import type { AgentEventSink } from "./agent-stream-response.js";
import type { InternalToolBatchLifecycle } from "./internal-hooks.js";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentTool,
  AgentToolCall,
  ToolLoopRecoveryState,
  ToolLoopWarning,
} from "./types.js";

export type ToolPlanState = { executionStarted: boolean };

export type ResolvedToolCallOutcome =
  | { kind: "resolved"; tool?: AgentTool }
  | { kind: "error"; error: unknown };

export type ToolBatchContext<TValidatedToolCallOutcome> = {
  currentContext: AgentContext;
  assistantMessage: AssistantMessage;
  config: AgentLoopConfig;
  signal: AbortSignal | undefined;
  emit: AgentEventSink;
  resolved: Map<AgentToolCall, ResolvedToolCallOutcome>;
  validated: Map<AgentToolCall, TValidatedToolCallOutcome>;
  lifecycle?: InternalToolBatchLifecycle;
  warnings?: ToolLoopWarning[];
  onParallelStarted?: () => void;
  hasUnobservedAsyncToolResults: boolean;
  toolPlan: ToolPlanState;
  toolLoopRecoveryState: ToolLoopRecoveryState;
  waitForPrevious?: () => Promise<void>;
};
