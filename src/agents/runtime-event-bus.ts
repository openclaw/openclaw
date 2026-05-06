import type { AgentRunEvent } from "./runtime-backend.js";

export type RunEventBus = {
  emit(event: AgentRunEvent): Promise<void>;
  drain(): Promise<void>;
};

export type RunEventBusOptions = {
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
};

export function createRunEventBus(options: RunEventBusOptions = {}): RunEventBus {
  let queue = Promise.resolve();

  return {
    emit(event) {
      queue = queue.then(() => options.onEvent?.(event)).then(() => undefined);
      return queue;
    },
    drain() {
      return queue;
    },
  };
}
