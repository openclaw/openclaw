import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import type { onAgentEvent } from "../../../infra/agent-events.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export function registerRequesterSelfYieldFollowupTests<Response>({
  requesterSessionKey,
  createGatewayContext,
  getLifecycleHandler,
  callGatewayMock,
  getAgentCalls,
  emitCompleted,
  flushOwnedWork,
  flushAsync,
  wakeRequester,
  waitForDeliveredCleanup,
  setReleaseAgentCallGate,
}: {
  requesterSessionKey: string;
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
    const context = createGatewayContext();
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(() => context);
    const childSessionKey = "agent:main:subagent:self-yield-followup";
    const kickoffRunId = "run-self-yield-kickoff";
    const followupRunId = "run-self-yield-followup";
    await registry.registerSubagentRun(
      createSubagentRunParams({
        runId: kickoffRunId,
        childSessionKey,
        requesterAgentId: "main",
        expectsCompletionMessage: true,
        gatewayContextResolver: context.resolveGatewayContext,
      }),
    );
    expect(
      await registry.claimSubagentYield({
        runId: kickoffRunId,
        sessionKey: childSessionKey,
        agentId: "main",
        waitForMessage: true,
        hasPendingWork: () => false,
      }),
    ).toEqual({ messageWaitRegistered: true });
    await registry.registerSubagentRun(
      createSubagentRunParams({
        runId: followupRunId,
        childSessionKey,
        requesterAgentId: "main",
        expectsCompletionMessage: false,
        gatewayContextResolver: context.resolveGatewayContext,
      }),
    );
    getLifecycleHandler()({
      stream: "lifecycle",
      runId: kickoffRunId,
      seq: 1,
      ts: Date.now(),
      sessionKey: childSessionKey,
      data: { phase: "end", endedAt: Date.now(), yielded: true },
    });
    await flushOwnedWork();
    expect(registry.getSubagentRunByRunId(kickoffRunId)).toBeUndefined();
    expect(registry.getSubagentRunByRunId(followupRunId)).toMatchObject({
      requesterSessionKey,
      expectsCompletionMessage: true,
      taskRunId: kickoffRunId,
    });
    expect(getAgentCalls()).toHaveLength(0);

    const ordinaryEntered = createDeferred();
    const ordinaryRelease = createDeferred();
    setReleaseAgentCallGate(() => ordinaryRelease.resolve());
    const respond = callGatewayMock.getMockImplementation()!;
    callGatewayMock.mockImplementation(async (request) => {
      if (
        request.method === "agent" &&
        request.params?.idempotencyKey?.startsWith("announce:v1:")
      ) {
        ordinaryEntered.resolve();
        await ordinaryRelease.promise;
      }
      return respond(request);
    });
    const wakes: Array<Promise<boolean>> = [];
    vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockImplementation((params) => {
      const work = wakeRequester(params);
      wakes.push(work);
      return work;
    });
    emitCompleted(followupRunId, childSessionKey, "follow-up completed");
    const completion = flushOwnedWork();
    try {
      await awaitGateBeforeSettlement(
        ordinaryEntered.promise,
        completion,
        "adopted follow-up settled without an ordinary announcement",
      );
      // Recovery runs before the in-flight delivery receipt commits. Join every
      // real wake it starts so a competing completion cannot escape the assertion.
      await registry.testing.sweepOnceForTests();
      await flushAsync();
      await Promise.all(wakes);
    } finally {
      ordinaryRelease.resolve();
      await completion;
    }
    await flushOwnedWork();
    expect(getAgentCalls()).toHaveLength(1);
    expect(registry.getSubagentRunByRunId(followupRunId)).toMatchObject({
      delivery: { status: "delivered" },
    });
    await waitForDeliveredCleanup(followupRunId);
  });
}
