import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerCompletedFollowupAuthorityTests({
  registration,
  updateRun,
}: {
  registration: (
    runId: string,
    overrides?: Partial<Parameters<typeof registerSubagentRun>[0]>,
  ) => Parameters<typeof registerSubagentRun>[0];
  updateRun: (runId: string, update: (draft: SubagentRunRecord) => void) => Promise<void>;
}) {
  it.each(["original", "successor"] as const)(
    "keeps completed-result and followup custody independent when the %s source is revoked",
    async (revokedOwner) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const context = createContext();
        const resolveGatewayContext = () => context;
        context.resolveGatewayContext = resolveGatewayContext;
        const captureSource = async (profileName: string) => {
          const client = createOperatorClient({ profileName, scopes: ["operator.write"] });
          const revoked = new AbortController();
          const source = expectDefined(
            await operatorCapture.captureGatewayOperatorRunAuthority({
              client,
              context,
              sourceAuthority: {
                signal: revoked.signal,
                assertCurrent: () => revoked.signal.throwIfAborted(),
              },
            }),
            "completion followup source",
          );
          client.internal = { operatorRunAuthority: source.authority };
          return { client, revoked, source };
        };
        const original = await captureSource("completion-owner");
        let followup: Awaited<ReturnType<typeof captureSource>> | undefined;
        try {
          await withPluginRuntimeGatewayRequestScope(
            {
              client: original.client,
              context,
              resolveGatewayContext,
              isWebchatConnect: () => false,
            },
            () =>
              registerSubagentRun(
                registration("child", { requesterAgentId: "main", requesterTurnRunId: "parent" }),
              ),
          );
          original.source.release();
          expect(original.source.authority.assertCurrent).not.toThrow();
          const entry = expectDefined(subagentRuns.get("child"), "completed child");
          await updateRun(entry.runId, (draft) => {
            draft.execution = { status: "terminal", endedAt: 1, outcome: { status: "ok" } };
            draft.delivery = { status: "pending" };
            draft.cleanupHandled = true; // Delivery is outside this custody proof.
          });
          followup = await captureSource("followup-owner");
          expect(
            await withPluginRuntimeGatewayRequestScope(
              {
                client: followup.client,
                context,
                resolveGatewayContext,
                isWebchatConnect: () => false,
              },
              () =>
                replaceSubagentRunAfterSteerCore({
                  previousRunId: entry.runId,
                  nextRunId: "successor",
                  expected: subagentRuns.get(entry.runId),
                  allowEndedSource: true,
                  preserveCompletedRun: true,
                  task: "second turn",
                }),
            ),
          ).toBe(true);
          followup.source.release();
          const retained = expectDefined(subagentRuns.get(entry.runId), "pending completed result");
          const successor = expectDefined(subagentRuns.get("successor"), "followup child");
          const stored = loadSubagentRegistryFromSqlite();
          expect(stored.get(entry.runId)).toMatchObject({
            execution: { status: "terminal", suppressSessionEffects: true },
            delivery: { status: "pending" },
            requesterTurnRunId: "parent",
          });
          expect(stored.get(successor.runId)).toMatchObject({
            taskRunId: successor.runId,
            task: "second turn",
            execution: { status: "running" },
          });
          expect(successor.requesterTurnRunId).toBeUndefined();
          expect(successor.requesterTurnYielded).toBeUndefined();
          const completionSource = (run: SubagentRunRecord) =>
            subagentRuns.runWithCompletionAuthority(
              run,
              () =>
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority
                  ?.source,
            );
          // Suppressing old session effects must not retire its pending result's custody.
          expect(completionSource(retained)).toBe(original.source.authority.source);
          expect(completionSource(successor)).toBe(followup.source.authority.source);
          const revokeOriginal = revokedOwner === "original";
          (revokeOriginal ? original.revoked : followup.revoked).abort(
            new Error("operator revoked"),
          );
          expect(() => completionSource(revokeOriginal ? retained : successor)).toThrow(
            /authority/,
          );
          expect(completionSource(revokeOriginal ? successor : retained)).toBe(
            revokeOriginal ? followup.source.authority.source : original.source.authority.source,
          );
          await releaseSubagentRun(entry.runId);
          await releaseSubagentRun(successor.runId);
          expect(original.source.authority.assertCurrent).toThrow();
          expect(() => subagentRuns.runWithCompletionAuthority(entry, () => "stale")).toThrow(
            /authority/,
          );
        } finally {
          original.source.release();
          followup?.source.release();
          await resetSubagentRegistryForTests({ persist: false });
        }
      });
    },
  );
}
