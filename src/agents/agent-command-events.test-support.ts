import { vi, type Mock } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";

type EventMockState = {
  agentEventListeners: Map<string, Set<(event: AgentEventPayload) => void>>;
  assertLifecycleCurrentMock: Mock;
  emitAgentEventMock: Mock;
};

export function resetAgentEventMock(state: EventMockState): void {
  state.agentEventListeners.clear();
  state.emitAgentEventMock.mockImplementation((event: AgentEventPayload) => {
    // Subscription changes during a callback affect the next event, not this batch.
    const listeners = [...(state.agentEventListeners.get(event.runId) ?? [])];
    for (const listener of listeners) {
      listener(event);
    }
  });
}

/** Command fixtures preserve the run-scoped subscription and idempotent release contract. */
export function createAgentEventMock(state: EventMockState) {
  return {
    assertAgentRunLifecycleGenerationCurrent: (...args: unknown[]) =>
      state.assertLifecycleCurrentMock(...args),
    captureAgentRunLifecycleGeneration: () => "test-generation",
    emitAgentEvent: (...args: unknown[]) => state.emitAgentEventMock(...args),
    getAgentEventLifecycleGeneration: () => "test-generation",
    isAgentEventLifecycleGenerationCurrent: (generation: string) =>
      generation === "test-generation",
    onAgentEvent: vi.fn(() => () => {}),
    onAgentEventForRun: (runId: string, listener: (event: AgentEventPayload) => void) => {
      const listeners = state.agentEventListeners.get(runId) ?? new Set();
      state.agentEventListeners.set(runId, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          state.agentEventListeners.delete(runId);
        }
      };
    },
    registerAgentEventLifecycleRotationHandler: vi.fn(),
    withAgentRunLifecycleGeneration: (_generation: string, run: () => unknown) => run(),
  };
}
