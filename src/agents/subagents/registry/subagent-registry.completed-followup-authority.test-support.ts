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
  it("preserves a pending completed result separately from a fresh followup execution", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const original = operatorFixture("completion-owner");
      const followup = operatorFixture("followup-owner");
      try {
        await withPluginRuntimeGatewayRequestScope(
          { ...original, isWebchatConnect: () => false },
          () =>
            registerSubagentRun(
              registration("child", {
                requesterAgentId: "main",
                requesterTurnRunId: "parent",
                gatewayContextResolver: original.resolveGatewayContext,
              }),
            ),
        );
        const entry = expectDefined(subagentRuns.get("child"), "completed child");
        await updateRun(entry.runId, (draft) => {
          draft.execution = { status: "terminal", endedAt: 1, outcome: { status: "ok" } };
          draft.delivery = { status: "pending" };
          draft.cleanupHandled = true; // Pending delivery is retained without running it here.
        });
        expect(
          await withPluginRuntimeGatewayRequestScope(
            { ...followup, isWebchatConnect: () => false },
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
        original.revoked.abort(new Error("original operator revoked"));
        followup.revoked.abort(new Error("followup operator revoked"));
        withPluginRuntimeGatewayRequestScope({ ...followup, isWebchatConnect: () => false }, () => {
          const assertNoOperator = () =>
            expect(
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
            ).toBeUndefined();
          subagentRuns.runWithCompletionContext(retained, assertNoOperator);
          subagentRuns.runWithCompletionContext(successor, assertNoOperator);
          subagentRuns.runWithCompletionBatchContext([retained, successor], assertNoOperator);
        });
        await releaseSubagentRun(entry.runId);
        await releaseSubagentRun(successor.runId);
      } finally {
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  });
}
