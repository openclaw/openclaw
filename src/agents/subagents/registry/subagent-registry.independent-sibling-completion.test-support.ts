import { expect, it, vi, type Mock } from "vitest";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { createOperatorClient } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import type {
  GatewayRequest,
  GatewayResponse,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import {
  createRequesterYieldTool,
  visibleChild,
} from "./subagent-registry.requester-wake-receipts.test-support.js";
import type { RequesterWakeFixture } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export function registerIndependentSiblingCompletionTests({
  requesterSessionKey,
  createGatewayContext,
  spawnVisibleChild,
  settleTurn,
  emitCompleted,
  flushOwnedWork,
  waitForDeliveredCleanup,
  getRequesterWakeCalls,
  getAgentCalls,
  callGatewayMock,
}: RequesterWakeFixture & {
  callGatewayMock: Mock<(request: GatewayRequest) => Promise<GatewayResponse>>;
}) {
  it.each([false, true])(
    "returns both independently admitted siblings exactly once (origin retired=%s)",
    async (retireOrigin) => {
      const context = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => context);
      const sources = await Promise.all(
        ["alpha-owner", "beta-owner"].map(async (profileName) => {
          const client = createOperatorClient({ profileName, scopes: ["operator.write"] });
          const access = new AbortController();
          const invocation = new AbortController();
          const source = await captureGatewayOperatorRunAuthority({
            client,
            context,
            sourceAuthority: {
              signal: access.signal,
              assertCurrent: () => access.signal.throwIfAborted(),
            },
            invocationAuthority: {
              signal: invocation.signal,
              assertCurrent: () => invocation.signal.throwIfAborted(),
            },
          });
          if (!source) {
            throw new Error("Expected an independently admitted operator source");
          }
          client.internal = { operatorRunAuthority: source.authority };
          return { client, source, invocation, access };
        }),
      );
      const requesterTurnRunId = "independent-sibling-parent";
      const children = [visibleChild("independent-alpha"), visibleChild("independent-beta")];
      const wakeAuthorities = new Map<object, unknown>();
      const original = callGatewayMock.getMockImplementation()!;
      callGatewayMock.mockImplementation((request) => {
        wakeAuthorities.set(
          request,
          getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
        );
        return original(request);
      });
      try {
        for (const [index, child] of children.entries()) {
          const source = sources[index]!;
          await withPluginRuntimeGatewayRequestScope(
            {
              client: source.client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () => spawnVisibleChild({ ...child, requesterTurnRunId }),
          );
        }
        for (const child of children) {
          expect(registry.getSubagentRunByRunId(child.runId)?.requesterTurnRunId).toBe(
            requesterTurnRunId,
          );
        }
        const yielded = await createRequesterYieldTool(
          requesterSessionKey,
          requesterTurnRunId,
        ).execute("yield-independent-siblings", {});
        expect(yielded).toMatchObject({ details: { status: "yielded" } });
        await settleTurn(requesterTurnRunId, children);
        if (retireOrigin) {
          // The invocation ends, but its operator access and both accepted child records survive.
          for (const source of sources) {
            source.invocation.abort(new Error("originating invocation retired"));
            expect(source.source.authority.assertCurrent).toThrow();
            expect(source.access.signal.aborted).toBe(false);
            source.source.release();
          }
        }
        emitCompleted(children[0]!.runId, children[0]!.childSessionKey, "ALPHA INDEPENDENT RESULT");
        emitCompleted(children[1]!.runId, children[1]!.childSessionKey, "BETA INDEPENDENT RESULT");
        await flushOwnedWork();
        await vi.waitFor(() => {
          for (const child of children) {
            expect(registry.getSubagentRunByRunId(child.runId)).toMatchObject({
              execution: { status: "terminal", outcome: { status: "ok" } },
            });
          }
          expect(getRequesterWakeCalls()).toHaveLength(1);
        });
        const message = getRequesterWakeCalls()[0]!.params?.message;
        expect(message?.match(/ALPHA INDEPENDENT RESULT/g)).toHaveLength(1);
        expect(message?.match(/BETA INDEPENDENT RESULT/g)).toHaveLength(1);
        // Internal return routing must not impersonate either sibling's operator.
        const wake = getRequesterWakeCalls()[0]!;
        expect(wakeAuthorities.has(wake)).toBe(true);
        expect(wakeAuthorities.get(wake)).toBeUndefined();
        for (const child of children) {
          await waitForDeliveredCleanup(child.runId);
        }
        for (const child of children) {
          emitCompleted(child.runId, child.childSessionKey, "duplicate terminal event");
        }
        await flushOwnedWork();
        expect(getRequesterWakeCalls()).toHaveLength(1);
        expect(getAgentCalls()).toHaveLength(1);
      } finally {
        callGatewayMock.mockImplementation(original);
        for (const source of sources) {
          source.source.release();
        }
      }
    },
  );
}
