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
import type { RegistryRegistrationFixture } from "./subagent-registry.requester-completion.fixture.test-support.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function operatorFixture(
  profileName: string,
  attachAccess = true,
  context = createContext(),
  resolveGatewayContext = () => context,
) {
  context.resolveGatewayContext = resolveGatewayContext;
  const client = createOperatorClient({ profileName, scopes: ["operator.write"] });
  const revoked = new AbortController();
  const sourceAuthority = {
    signal: revoked.signal,
    assertCurrent: () => revoked.signal.throwIfAborted(),
  };
  if (attachAccess) {
    client.internal = { operatorAccessAuthority: sourceAuthority };
  }
  return { context, resolveGatewayContext, client, revoked, sourceAuthority };
}

export async function retainedOperatorFixture(
  profileName: string,
  context?: ReturnType<typeof createContext>,
  resolveGatewayContext?: () => ReturnType<typeof createContext>,
) {
  const fixture = operatorFixture(profileName, false, context, resolveGatewayContext);
  const source = expectDefined(
    await operatorCapture.captureGatewayOperatorRunAuthority(fixture),
    "operator registration source",
  );
  fixture.client.internal = { operatorRunAuthority: source.authority };
  return { ...fixture, source };
}

export function registerCompletedFollowupAuthorityTests({
  registration,
  updateRun,
}: RegistryRegistrationFixture) {
  it.each(["original", "successor"] as const)(
    "keeps completed-result and followup custody independent when the %s source is revoked",
    (revokedOwner) =>
      withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const context = createContext();
        const resolveGatewayContext = () => context;
        const captureSource = async (profileName: string) => {
          const { source, revoked, client } = await retainedOperatorFixture(
            profileName,
            context,
            resolveGatewayContext,
          );
          return {
            ...source,
            revoked,
            run: <T>(work: () => T) =>
              withPluginRuntimeGatewayRequestScope(
                { client, context, resolveGatewayContext, isWebchatConnect: () => false },
                work,
              ),
          };
        };
        const original = await captureSource("completion-owner");
        let followup: Awaited<ReturnType<typeof captureSource>> | undefined;
        try {
          await original.run(() =>
            registerSubagentRun(
              registration("child", { requesterAgentId: "main", requesterTurnRunId: "parent" }),
            ),
          );
          original.release();
          expect(original.authority.assertCurrent).not.toThrow();
          const entry = expectDefined(subagentRuns.get("child"), "completed child");
          await updateRun(entry.runId, (draft) => {
            draft.execution = { status: "terminal", endedAt: 1, outcome: { status: "ok" } };
            draft.delivery = { status: "pending" };
            draft.cleanupHandled = true; // Delivery is outside this custody proof.
          });
          followup = await captureSource("followup-owner");
          expect(
            await followup.run(() =>
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
          followup.release();
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
          expect(completionSource(retained)).toBe(original.authority.source);
          expect(completionSource(successor)).toBe(followup.authority.source);
          const revokeOriginal = revokedOwner === "original";
          (revokeOriginal ? original.revoked : followup.revoked).abort(
            new Error("operator revoked"),
          );
          expect(() => completionSource(revokeOriginal ? retained : successor)).toThrow(
            /authority/,
          );
          expect(completionSource(revokeOriginal ? successor : retained)).toBe(
            revokeOriginal ? followup.authority.source : original.authority.source,
          );
          await releaseSubagentRun(entry.runId);
          await releaseSubagentRun(successor.runId);
          expect(original.authority.assertCurrent).toThrow();
          expect(() => subagentRuns.runWithCompletionAuthority(entry, () => "stale")).toThrow(
            /authority/,
          );
        } finally {
          original.release();
          followup?.release();
          await resetSubagentRegistryForTests({ persist: false });
        }
      }),
  );
}
