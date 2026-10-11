// Gateway-bound proof for writer-claim rebound delivery classification: the
// announcement retry owner must exhaust its bounded schedule against a running
// in-process Gateway, keep the exhausted writer rebound retryable, and leave
// the completion obligation to exactly one successful recovery turn.
// Preserve harness setup before modules that consume it.
// oxfmt-ignore
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { AgentRunTerminalOutcome } from "../../../agents/agent-run-terminal-outcome.types.js";
import { SessionTranscriptWriterClaimReboundError } from "../../../config/sessions/session-transcript-writer-claim-error.js";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import {
  getAgentTestMocks,
  makeContext,
  primeMainAgentRun,
} from "../../../gateway/server-methods/agent.test-harness.js";
import "../../../gateway/server-methods/agent.mocks.test-utils.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "../../../gateway/server-methods/types.js";
import { setGatewayPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata-snapshot.js";
import {
  retainGatewayPluginMetadata,
  type GatewayPluginMetadataOwner,
} from "../../../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../../../test-utils/gateway-scheduler-clock.js";
import { deliverSubagentAnnouncement } from "./subagent-announce-delivery.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";

let metadataOwner: GatewayPluginMetadataOwner | undefined;
beforeAll(() => {
  // Direct handler cases share the real startup inventory; admission consumes
  // prepared plugin metadata like a live Gateway would.
  metadataOwner = retainGatewayPluginMetadata(createTestGatewayScheduler());
  const snapshot = metadataOwner.runBootstrap(() =>
    loadPluginMetadataSnapshot({ config: {}, allowCurrent: false }),
  );
  metadataOwner.publish(snapshot);
  setGatewayPluginMetadataSnapshot(snapshot, { config: {} });
});
afterAll(async () => {
  await metadataOwner?.close();
});

const mocks = getAgentTestMocks();

/**
 * The agent harness context carries the real Gateway session projection but no
 * facade; nested announce dispatches need one bound to the same instance.
 */
function withAgentTurnFacade(context: GatewayRequestContext): GatewayRequestContext {
  context.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => context,
      getMethodRegistry: () => createRegistry({}),
    });
  return context;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: WRITE_SCOPE,
    })),
  );
}

const requesterSessionKey = "agent:main:main";
const origin = { channel: "discord", to: "dm:U123", accountId: "acct-1" };

function deliveryParams(directIdempotencyKey: string) {
  return {
    requesterSessionKey,
    targetRequesterSessionKey: requesterSessionKey,
    triggerMessage: "all spawned subagents settled",
    requesterSessionOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: false,
    requireDirectDelivery: true,
    // Parent-private settle deliveries own their recovery retries: the Gateway
    // retires the prior terminal projection on each admission instead of
    // replaying the cached failure.
    completionTarget: "parent" as const,
    completionRequesterSessionId: "existing-session-id",
    directIdempotencyKey,
    sourceTool: "subagent_settle" as const,
  };
}

describe("subagent announce writer-rebound Gateway recovery proof", () => {
  it("exhausts writer-rebound turns against a running Gateway and stays retryable", async () => {
    const writerReboundThrows = new SessionTranscriptWriterClaimReboundError();
    primeMainAgentRun();
    // Private requester turns settle their staged input with the terminal
    // outcome, mirroring the durable pending-input receipt production stages.
    const stageInput = mocks.stageSessionPendingInput.getMockImplementation();
    if (!stageInput) {
      throw new Error("Expected the in-memory session input fixture");
    }
    mocks.stageSessionPendingInput.mockImplementation(async (scope, options) => {
      const input = await stageInput(scope, options);
      return input
        ? {
            ...input,
            completeAsync: async (terminal: AgentRunTerminalOutcome) => {
              options.assertCompletionCurrent?.();
              return terminal;
            },
          }
        : undefined;
    });
    mocks.agentCommand.mockRejectedValue(writerReboundThrows);
    setSubagentAnnounceDeliveryDepsForTest({
      getRuntimeConfig: () => ({}),
      getRequesterSessionActivity: () => ({ sessionId: "existing-session-id", isActive: true }),
      loadRequesterSessionEntry: () => ({
        cfg: {},
        canonicalKey: requesterSessionKey,
        agentId: "main",
        entry: {
          sessionId: "existing-session-id",
          updatedAt: 1,
        },
      }),
    });
    onTestFinished(() => {
      mocks.stageSessionPendingInput.mockImplementation(stageInput);
      mocks.agentCommand.mockReset();
      setSubagentAnnounceDeliveryDepsForTest();
    });

    const context = withAgentTurnFacade(makeContext());
    context.trackExecution = trackAsyncWork;
    const deliver = () =>
      withPluginRuntimeGatewayContextResolver(
        () => context,
        () => deliverSubagentAnnouncement(deliveryParams("announce:writer-rebound-proof")),
      );

    // Every bounded schedule attempt reaches the Gateway as a real agent turn
    // and comes back with the writer-claim rebound; the exhausted failure must
    // stay retryable so the requester settle wake keeps the recovery obligation.
    const exhausted = await deliver();
    expect(exhausted).toMatchObject({
      delivered: false,
      path: "direct",
      disposition: "retryable",
      error: "session writer claim changed before transcript persistence",
    });
    expect(mocks.agentCommand).toHaveBeenCalledTimes(4);

    // Bounded requester recovery replays the same persisted idempotency key
    // once the transient writer-claim contention has cleared.
    mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "recovered child completion" }] });
    const turnsAfterExhaustion = mocks.agentCommand.mock.calls.length;
    const recovery = await deliver();
    expect(recovery).toMatchObject({ delivered: true, path: "direct" });
    // The recovery replay executes exactly one additional requester turn, so
    // the exhausted schedule and the recovery share one completion obligation:
    // the failure turns never commit a visible completion.
    expect(mocks.agentCommand.mock.calls.length).toBe(turnsAfterExhaustion + 1);
    expect(recovery.phases).toHaveLength(1);
  });
});
