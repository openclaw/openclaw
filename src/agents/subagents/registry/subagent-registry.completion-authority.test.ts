import { afterEach, describe, expect, it, vi } from "vitest";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  getGatewayContextLifetime,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

const callGateway = vi.fn().mockResolvedValue({ status: "pending" });
afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  testing.setDepsForTest();
});

describe("registered completion source custody", () => {
  it.each([
    "settle",
    "release",
    "reset",
    "revoke",
    "gateway-close",
    "replace",
    "release-rejected",
    "registration-rejected",
    "cancelled-by-another-operator",
    "mixed-source",
    "mixed-cancellation-source",
    "mixed-cancellation-same-source",
    "stale-batch-member",
  ] as const)("outlives execution and closes on %s", async (ending) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      testing.setDepsForTest({ callGateway, onAgentEvent: () => () => {} });
      const context = createContext();
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const client = createOperatorClient({
        profileId: "completion-owner",
        scopes: ["operator.write"],
      });
      const revoked = new AbortController();
      const source = captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: revoked.signal,
          assertCurrent: () => revoked.signal.throwIfAborted(),
        },
      })!;
      client.internal = { operatorRunAuthority: source.authority };
      try {
        const register = (runId = "child", actor = client) =>
          withPluginRuntimeGatewayRequestScope(
            {
              client: actor,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              registerSubagentRun({
                runId,
                childSessionKey: `agent:main:subagent:${runId}`,
                requesterSessionKey: "agent:main:main",
                requesterAgentId: "main",
                requesterDisplayKey: "main",
                requesterTurnRunId: "parent",
                task: "result",
                cleanup: "keep",
                expectsCompletionMessage: true,
              }),
          );
        if (ending === "registration-rejected") {
          testing.setDepsForTest({
            callGateway,
            persistSubagentRunsToDiskOrThrow: () => {
              throw new Error("write refused");
            },
          });
          expect(register).toThrow("write refused");
          source.release();
          expect(source.authority.assertCurrent).toThrow();
          expect(subagentRuns.has("child")).toBe(false);
          return;
        }
        register();
        source.release();
        // This is the regression: execution closing must not close registered completion custody.
        expect(source.authority.assertCurrent).not.toThrow();
        const entry = subagentRuns.get("child")!;
        subagentRuns.runWithCompletionAuthority(entry, () => {
          const retained =
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
          expect(retained?.source).toBe(source.authority.source);
          expect(retained?.scopes).toEqual(["operator.write"]);
        });
        if (ending === "settle") {
          entry.execution = { status: "terminal", endedAt: 1, outcome: { status: "ok" } };
          entry.cleanupCompletedAt = 1;
          entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
          persistSubagentRunsToDiskOrThrow(subagentRuns, [entry.runId]);
          expect(source.authority.assertCurrent).not.toThrow();
          entry.requesterTurnRunId = undefined;
          entry.requesterSettleWake = undefined;
          entry.delivery = { status: "delivered" };
          persistSubagentRunsToDiskOrThrow(subagentRuns, [entry.runId]);
        } else if (ending === "cancelled-by-another-operator") {
          revoked.abort(new Error("operator revoked"));
          entry.execution = {
            status: "terminal",
            endedAt: 1,
            outcome: { status: "error", error: "cancelled" },
          };
          entry.endedReason = "subagent-killed";
          const observer = createOperatorClient({
            profileId: "cancellation-owner",
            scopes: ["operator.write"],
          });
          withPluginRuntimeGatewayRequestScope(
            { client: observer, context, isWebchatConnect: () => false },
            () =>
              subagentRuns.runWithCompletionAuthority(entry, () =>
                expect(getPluginRuntimeGatewayRequestScope()?.client).toBe(observer),
              ),
          );
          releaseSubagentRun(entry.runId);
        } else if (ending === "mixed-source" || ending === "mixed-cancellation-source") {
          register(
            "other",
            createOperatorClient({ profileId: "other-owner", scopes: ["operator.write"] }),
          );
          const other = subagentRuns.get("other")!;
          if (ending === "mixed-cancellation-source") {
            other.execution = {
              status: "terminal",
              endedAt: 1,
              outcome: { status: "error", error: "cancelled" },
            };
            other.endedReason = "subagent-killed";
          }
          expect(() =>
            subagentRuns.runWithCompletionBatchAuthority([entry, other], () => "wrong caller"),
          ).toThrow(/incompatible operator authority/);
          releaseSubagentRun(entry.runId);
          releaseSubagentRun(other.runId);
        } else if (ending === "mixed-cancellation-same-source" || ending === "stale-batch-member") {
          register("other");
          const other = subagentRuns.get("other")!;
          if (ending === "stale-batch-member") {
            subagentRuns.delete(other.runId);
            expect(() =>
              subagentRuns.runWithCompletionBatchAuthority([entry, other], () => "stale"),
            ).toThrow(/authority/);
            subagentRuns.set(other.runId, other);
          } else {
            other.execution = {
              status: "terminal",
              endedAt: 1,
              outcome: { status: "error", error: "cancelled" },
            };
            other.endedReason = "subagent-killed";
            subagentRuns.runWithCompletionBatchAuthority([other, entry], () =>
              expect(
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority
                  ?.source,
              ).toBe(source.authority.source),
            );
          }
          releaseSubagentRun(entry.runId);
          releaseSubagentRun(other.runId);
        } else if (ending === "release") {
          releaseSubagentRun(entry.runId);
        } else if (ending === "reset") {
          resetSubagentRegistryForTests({ persist: false });
        } else if (ending === "gateway-close") {
          getGatewayContextLifetime(resolveGatewayContext).abort();
        } else if (ending === "replace") {
          expect(
            replaceSubagentRunAfterSteerCore({
              previousRunId: entry.runId,
              nextRunId: "successor",
              expected: entry,
              preserveRequesterSettleWake: true,
            }),
          ).toBe(true);
          expect(source.authority.assertCurrent).not.toThrow();
          expect(() => subagentRuns.runWithCompletionAuthority(entry, () => "stale")).toThrow(
            /authority/,
          );
          releaseSubagentRun("successor");
        } else if (ending === "release-rejected") {
          testing.setDepsForTest({
            callGateway,
            persistSubagentRunsToDiskOrThrow: () => {
              throw new Error("write refused");
            },
          });
          expect(() => releaseSubagentRun(entry.runId)).toThrow("write refused");
          expect(source.authority.assertCurrent).not.toThrow();
          testing.setDepsForTest({ callGateway, onAgentEvent: () => () => {} });
          releaseSubagentRun(entry.runId);
        } else {
          revoked.abort(new Error("operator revoked"));
        }
        expect(source.authority.assertCurrent).toThrow();
        expect(() => subagentRuns.runWithCompletionAuthority(entry, () => "stale")).toThrow(
          /authority/,
        );
      } finally {
        source.release();
        resetSubagentRegistryForTests({ persist: false });
      }
    });
  });
});
