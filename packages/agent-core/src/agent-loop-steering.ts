import { getInternalSyncSteeringGetter } from "./internal-hooks.js";
import type { AgentLoopConfig, AgentMessage, AgentToolCall } from "./types.js";

/**
 * Launch checkpoints pass the call about to start. A call that delivers the turn's visible
 * reply is not a skip point, so steering stays queued and follows that call's result.
 */
export function getSteeringAtCheckpoint(
  config: AgentLoopConfig,
  launchingCall?: AgentToolCall,
): AgentMessage[] | Promise<AgentMessage[]> {
  const callback = config.getSteeringMessages;
  if (!callback || (launchingCall && config.deliversVisibleReply?.(launchingCall))) {
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
