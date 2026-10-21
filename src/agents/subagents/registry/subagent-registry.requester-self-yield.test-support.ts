import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import type { onAgentEvent } from "../../../infra/agent-events.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import type { PrepareRequesterWakeChildSession } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export function registerRequesterSelfYieldFollowupTests<Response>(fixture: {
  requesterSessionKey: string;
  prepareChildSession: PrepareRequesterWakeChildSession;
  createGatewayContext: () => GatewayRequestContext;
  getLifecycleHandler: () => Parameters<typeof onAgentEvent>[0];
  callGatewayMock: Mock<(request: GatewayRequest) => Promise<Response>>;
  getAgentCalls: () => GatewayRequest[];
  emitCompleted: (runId: string, childSessionKey: string, text: string) => void;
  flushOwnedWork: () => Promise<void>;
  flushAsync: () => Promise<void>;
  wakeRequester: typeof maybeWakeRequesterAfterAllChildrenSettled;
  waitForDeliveredCleanup: (runId: string) => Promise<void>;
  setReleaseAgentCallGate: (release: () => void) => void;
}) {
  it("delivers an adopted self-yield follow-up once while ordinary announce is in flight", async () => {
    vi.setSystemTime(100_000);
    const context = fixture.createGatewayContext();
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(() => context);
    const childSessionKey = "agent:main:subagent:self-yield-followup";
    const kickoffRunId = "run-self-yield-kickoff";
    const followupRunId = "run-self-yield-followup";
    const sessionEntry = await fixture.prepareChildSession(
      childSessionKey,
      "sess-self-yield-followup",
    );
    const register = (runId: string, expectsCompletionMessage: boolean) =>
      registry.registerSubagentRun(
        createSubagentRunParams({
          runId,
          childSessionKey,
          sessionEntry,
          requesterAgentId: "main",
          expectsCompletionMessage,
          gatewayContextResolver: context.resolveGatewayContext,
        }),
      );
    await register(kickoffRunId, true);
    await registry.claimSubagentYield({
      runId: kickoffRunId,
      sessionKey: childSessionKey,
      agentId: "main",
      waitForMessage: true,
      hasPendingWork: () => false,
    });
    await register(followupRunId, false);
    fixture.getLifecycleHandler()({
      stream: "lifecycle",
      runId: kickoffRunId,
      seq: 1,
      ts: Date.now(),
      sessionKey: childSessionKey,
      data: { phase: "end", endedAt: Date.now(), yielded: true },
    });
    await fixture.flushOwnedWork();

    const ordinaryEntered = createDeferred();
    const ordinaryRelease = createDeferred();
    fixture.setReleaseAgentCallGate(() => ordinaryRelease.resolve());
    const respond = fixture.callGatewayMock.getMockImplementation()!;
    fixture.callGatewayMock.mockImplementation(async (request) => {
      if (
        request.method === "agent" &&
        request.params?.idempotencyKey?.startsWith("announce:v1:")
      ) {
        ordinaryEntered.resolve();
        await ordinaryRelease.promise;
      }
      return respond(request);
    });
    const wakes = vi
      .mocked(maybeWakeRequesterAfterAllChildrenSettled)
      .mockClear()
      .mockImplementation(fixture.wakeRequester);
    fixture.emitCompleted(followupRunId, childSessionKey, "follow-up completed");
    const completion = fixture.flushOwnedWork();
    try {
      await awaitGateBeforeSettlement(
        ordinaryEntered.promise,
        completion,
        "adopted follow-up settled without an ordinary announcement",
      );
      // Join all recovery wakes started before the delivery receipt commits.
      await registry.testing.sweepOnceForTests();
      await fixture.flushAsync();
      await Promise.all(wakes.mock.results.map(({ value }) => value));
    } finally {
      ordinaryRelease.resolve();
      await completion;
    }
    await fixture.flushOwnedWork();
    expect(fixture.getAgentCalls()).toHaveLength(1);
    await fixture.waitForDeliveredCleanup(followupRunId);
  });
}
