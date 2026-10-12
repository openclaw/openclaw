/**
 * Shared fixture surface for the "subagent registry seam flow" suite.
 *
 * The suite in subagent-registry.test.ts owns the hoisted mock state and the
 * harness; sibling case modules receive exactly this surface so they observe
 * the same module graph without re-declaring a single vi.mock.
 */
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRegistryMockState = ReturnType<typeof createSubagentRegistryMockState>;

export type SubagentLifecycleTestEvent = Pick<AgentEventPayload, "runId" | "stream" | "data"> &
  Partial<AgentEventPayload>;

export type ObservedTerminalSignal = {
  kind: string;
  summary?: string;
  outcome?: string;
};

export type SubagentRegistrySeamFixture = {
  mocks: SubagentRegistryMockState;
  /** Reads the harness the owning suite rebuilds in its beforeAll. */
  getRegistry: () => SubagentRegistryHarness;
  hydrateAndActivateRegistry: () => Promise<void>;
  findRequesterRun: (runId: string, requesterSessionKey?: string) => SubagentRunRecord | undefined;
  observerTerminalSignals: (runId: string) => Promise<ObservedTerminalSignal[]>;
  mockAgentWait: (
    response:
      | Record<string, unknown>
      | Promise<Record<string, unknown>>
      | Error
      | ((
          request: Parameters<SubagentRegistryMockState["callGateway"]>[0],
        ) => Record<string, unknown>),
  ) => void;
  mockPendingAgentWait: () => void;
  mockSingleCollectorConcurrency: () => void;
  getLifecycleHandler: () => (event: SubagentLifecycleTestEvent) => unknown;
  settleLifecycle: (event: SubagentLifecycleTestEvent) => Promise<void>;
};
