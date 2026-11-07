import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import type { RegistryRegistrationFixture } from "./subagent-registry.requester-completion.fixture.test-support.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

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

export function registerCompletedFollowupOwnershipTests({
  registration,
  updateRun,
}: RegistryRegistrationFixture) {
  it.each(["original", "successor"] as const)(
    "keeps completed-result and followup ownership independent when the %s source is revoked",
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
          expect(original.authority.assertCurrent).toThrow();
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
          // Superseding session effects must not retire an already completed result.
          expect(subagentRuns.isCompletionRetired(retained)).toBe(false);
          expect(subagentRuns.isCompletionRetired(successor)).toBe(false);
          const revokeOriginal = revokedOwner === "original";
          (revokeOriginal ? original.revoked : followup.revoked).abort(
            new Error("operator revoked"),
          );
          expect((revokeOriginal ? original : followup).authority.assertCurrent).toThrow();
          expect((revokeOriginal ? followup : original).authority.assertCurrent).toThrow();
          expect(subagentRuns.isCompletionRetired(retained)).toBe(false);
          expect(subagentRuns.isCompletionRetired(successor)).toBe(false);
          await releaseSubagentRun(entry.runId);
          await releaseSubagentRun(successor.runId);
          expect(subagentRuns.has(entry.runId)).toBe(false);
          expect(subagentRuns.has(successor.runId)).toBe(false);
        } finally {
          original.release();
          followup?.release();
          await resetSubagentRegistryForTests({ persist: false });
        }
      }),
  );
}
