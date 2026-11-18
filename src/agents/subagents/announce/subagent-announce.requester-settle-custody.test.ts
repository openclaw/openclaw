import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayClientRequestError } from "../../../../packages/gateway-client/src/request-error.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { toSandboxProvisioningError } from "../../sandbox/provisioning-error.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  deliver,
  registryRead,
  REQUESTER_KEY,
  settledChild,
  publishWakeTransition,
  useRequesterSettleDispatchFixture,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

describe("requester settle custody", () => {
  useRequesterSettleDispatchFixture();
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => clearRuntimeConfigSnapshot());

  it.each([false, true])("keeps separate requester invocations (frozen=%s)", async (frozen) => {
    const source = {};
    const children = ["first", "second"].map((runId) =>
      Object.assign(settledChild(), {
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        completion: { required: true, resultText: runId + " findings", capturedAt: 3000 },
        delivery: { status: "pending" as const },
      }),
    );
    let admitted: string | undefined;
    for (const child of children) {
      if (frozen) {
        child.requesterSettleWake!.batchRunIds = children.map((member) => member.runId);
      }
      subagentRuns.set(child.runId, child);
      onTestFinished(() => {
        subagentRuns.delete(child.runId);
      });
      subagentRuns.bindCompletionAuthority(
        child,
        {
          operatorAuthority: {
            source,
            scopes: ["operator.write"],
            profileId: "owner",
            assertCurrent() {},
          },
          assertCurrent() {},
          release() {},
          signal: new AbortController().signal,
          run<T>(work: () => T): T {
            admitted = child.runId;
            return work();
          },
        },
        { runId: child.runId + "-requester", instanceId: child.runId + "-instance" },
      );
    }
    registryRead.listSubagentRunsForRequester.mockReturnValue(children);
    const received: Array<{ admitted: string | undefined; message: string }> = [];
    deliver.mockImplementation(async ({ triggerMessage }: { triggerMessage: string }) => {
      received.push({ admitted, message: triggerMessage });
      return { delivered: true, path: "direct" };
    });
    for (const settledEntry of children) {
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled({
          isSourceCurrent: () => true,
          requesterSessionKey: REQUESTER_KEY,
          settledEntry,
          transitionBatch: publishWakeTransition,
          completeBatch(batch) {
            for (const entry of batch) {
              entry.requesterSettleWake = undefined;
            }
            return Promise.resolve();
          },
        }),
      ).resolves.toBe(true);
    }
    expect(received.map((item) => item.admitted)).toEqual(["first", "second"]);
    expect(received[0]?.message).toContain("first findings");
    expect(received[0]?.message).not.toContain("second findings");
    expect(received[1]?.message).toContain("second findings");
    expect(received[1]?.message).not.toContain("first findings");
  });

  it.each([
    {
      error: toSandboxProvisioningError(new Error("Cannot start sandbox"), "synthetic"),
      started: false,
    },
    {
      error: new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "Gateway is preparing",
      }),
      started: false,
    },
    {
      error: new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "Gateway is preparing",
      }),
      started: true,
    },
  ])(
    "preserves only pre-execution setup refusals: $error, started=$started",
    async ({ error, started }) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const child = settledChild();
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      deliver.mockImplementation(
        async (
          params: Parameters<
            typeof import("./subagent-announce-delivery.js").deliverSubagentAnnouncement
          >[0],
        ) => {
          if (started) {
            params.onExecutionStarted?.();
          }
          params.onDeliveryError?.(error);
          return {
            delivered: false,
            path: "direct",
            disposition: "retryable",
            error: error.message,
          };
        },
      );
      const completeBatch = vi.fn();
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled({
          isSourceCurrent: () => true,
          requesterSessionKey: REQUESTER_KEY,
          settledEntry: child,
          transitionBatch: publishWakeTransition,
          completeBatch,
        }),
      ).resolves.toBe(false);
      expect(completeBatch).not.toHaveBeenCalled();
      expect(child.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: started ? 1 : 0,
        nextAttemptAt: 40_000,
      });
    },
  );
});
