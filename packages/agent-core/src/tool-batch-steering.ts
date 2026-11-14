import { getSteeringAtCheckpoint } from "./agent-loop-steering.js";
import { getInternalToolSteeringAllowance } from "./internal-hooks.js";
import type { ToolBatchContext } from "./tool-batch-context.js";
import type { AgentLoopConfig, AgentMessage, AgentToolCall } from "./types.js";

type ToolBatchLookupContext = Pick<ToolBatchContext<unknown>, "currentContext" | "resolved">;
type PreparedCallEntry = {
  kind?: unknown;
  toolCall?: AgentToolCall;
  execution?: { args: unknown };
};

export function hidesToolCallFromChannelProgress(
  batch: ToolBatchLookupContext,
  toolCall: AgentToolCall,
): boolean {
  const resolution = batch.resolved.get(toolCall);
  const tool =
    resolution?.kind === "resolved"
      ? resolution.tool
      : batch.currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
  return tool?.hideFromChannelProgress === true;
}

export async function resolveToolSteeringCheckpoint(
  config: AgentLoopConfig,
  batch: ToolBatchLookupContext,
  currentMessages: AgentMessage[],
  call?: AgentToolCall | { toolCall: AgentToolCall; args: unknown },
): Promise<{ steeringMessages: AgentMessage[]; allowSteeredCall: boolean }> {
  let steeringMessages = currentMessages;
  if (steeringMessages.length === 0) {
    const steering = getSteeringAtCheckpoint(config);
    steeringMessages = Array.isArray(steering) ? steering : await steering;
  }
  const preparedCall = call
    ? "toolCall" in call
      ? call
      : { toolCall: call, args: call.arguments }
    : undefined;
  const resolution = preparedCall && batch.resolved.get(preparedCall.toolCall);
  const tool = preparedCall
    ? resolution
      ? resolution.kind === "resolved"
        ? resolution.tool
        : undefined
      : batch.currentContext.tools?.find(
          (candidate) => candidate.name === preparedCall.toolCall.name,
        )
    : undefined;
  return {
    steeringMessages,
    allowSteeredCall: Boolean(
      steeringMessages.length > 0 &&
      tool &&
      getInternalToolSteeringAllowance(tool)?.(preparedCall?.args),
    ),
  };
}

export function preparedCallForSteering(
  entries: readonly PreparedCallEntry[],
): { toolCall: AgentToolCall; args: unknown } | undefined {
  const entry = entries.length === 1 ? entries[0] : undefined;
  return entry && "kind" in entry && entry.toolCall && entry.execution
    ? { toolCall: entry.toolCall, args: entry.execution.args }
    : undefined;
}
