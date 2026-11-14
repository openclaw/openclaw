import type { AgentEventSink } from "./agent-stream-response.js";
import {
  attachInternalSteeringQueueObserver,
  commitInternalToolTurnInput,
  getInternalSteeringQueueObserver,
  getInternalSyncSteeringGetter,
} from "./internal-hooks.js";
import { isOpenClawSystemUpdateMessage, orderSystemUpdateMessages } from "./operator-messages.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types.js";

export async function commitInputMessages(
  messages: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  newMessages: AgentMessage[],
  onUserMessage: () => void,
): Promise<boolean> {
  let injectedMessage = false;
  for (const message of orderSystemUpdateMessages(messages)) {
    if (config.consumeQueuedMessageCancellation?.(message)) {
      continue;
    }
    await emit({ type: "message_start", message });
    if (config.consumeQueuedMessageCancellation?.(message)) {
      continue;
    }
    if (message.role === "user") {
      onUserMessage();
    }
    context.messages.push(message);
    newMessages.push(message);
    if (!isOpenClawSystemUpdateMessage(message)) {
      // Acceptance precedes fallible publication so continuation cannot reuse the prior input.
      commitInternalToolTurnInput(config.completesToolTurn);
    }
    await emit({ type: "message_end", message });
    injectedMessage = true;
  }
  return injectedMessage;
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
  if (streamedConfig.getSteeringMessages) {
    attachInternalSteeringQueueObserver(
      streamedConfig.getSteeringMessages,
      getInternalSteeringQueueObserver(config.getSteeringMessages),
    );
  }
  return {
    config: streamedConfig,
    getTerminalConfig: () => (streamedSteering ? streamedConfig : config),
  };
}
