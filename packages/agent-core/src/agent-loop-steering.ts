import { getInternalSyncSteeringGetter } from "./internal-hooks.js";
import type { AgentLoopConfig, AgentMessage } from "./types.js";

export type ToolPlanState = { executionStarted: boolean };

export function createToolPlanState(): ToolPlanState {
  return { executionStarted: false };
}

export function getSteeringAtCheckpoint(
  config: AgentLoopConfig,
): AgentMessage[] | Promise<AgentMessage[]> {
  const callback = config.getSteeringMessages;
  if (!callback) {
    return [];
  }
  return getInternalSyncSteeringGetter(callback)?.() ?? callback.call(config);
}

export function createStreamedSteeringConfig(config: AgentLoopConfig) {
  let streamedSteering: Promise<AgentMessage[]> | undefined;
  const streamedConfig: AgentLoopConfig = {
    ...config,
    getSteeringMessages: async () => {
      if (streamedSteering) {
        return streamedSteering;
      }
      // Batches retain a drained FIFO batch until injection; empty sync drains stay uncached
      // so an overlapping checkpoint drains again instead of reusing a stale empty snapshot.
      const steering = getSteeringAtCheckpoint(config);
      if (Array.isArray(steering)) {
        if (steering.length > 0) {
          streamedSteering = Promise.resolve(steering);
        }
        return steering;
      }
      const drain = (streamedSteering = steering);
      const messages = await drain;
      if (messages.length === 0 && streamedSteering === drain) {
        streamedSteering = undefined;
      }
      return messages;
    },
  };
  return {
    config: streamedConfig,
    getTerminalConfig: () => (streamedSteering ? streamedConfig : config),
  };
}
