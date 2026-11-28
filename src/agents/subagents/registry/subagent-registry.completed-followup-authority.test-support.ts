import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { decideTurnGrant } from "../../../gateway/operator-admission.js";
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
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { createParticipationTestAuthority } from "../../participation-ceiling.test-support.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentCompletionCustody } from "./subagent-registry-memory.types.js";
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
    await operatorCapture.prepareGatewayOperatorRunAuthority({
      ...fixture,
      sourceAuthority: fixture.sourceAuthority,
    }),
    "operator registration source",
  );
  fixture.client.internal = { operatorRunAuthority: source.authority };
  return { ...fixture, source };
}

export function registerCompletedFollowupAuthorityTests({
  registration,
  updateRun,
}: RegistryRegistrationFixture) {
  it.each([false, true])(
    "separates complete participant restrictions, including cancellation=%s",
    (cancelled) => {
      setRuntimeConfigSnapshot({});
      const ceiling = createParticipationTestAuthority({
        kind: "send",
        profileId: "participant",
        sessionKey: "agent:main:original",
        tools: ["read"],
        permission: "guarded",
      }).participationCeiling!;
      const source = {};
      const invocation = {};
      const effect = vi.fn();
      const retained = vi.fn();
      const install = (runId: string, restriction: typeof ceiling | undefined) => {
        const entry: SubagentRunRecord = {
          ...registration(runId),
          createdAt: 1,
          requiresCompletionAuthority: restriction ? true : undefined,
          ...(cancelled ? { endedReason: SUBAGENT_ENDED_REASON_KILLED } : {}),
          execution: { status: "terminal", outcome: { status: cancelled ? "error" : "ok" } },
        };
        const authority = createAdmittedRunOperatorAuthority({
          canonicalIdentity: null,
          profileId: "participant",
          scopes: ["operator.write"],
          grant: decideTurnGrant(["operator.write"]),
          participationCeiling: restriction,
          source,
          invocation,
        });
        const run = <T>(work: () => T): T => {
          retained(runId);
          return work();
        };
        const custody: SubagentCompletionCustody["authority"] = {
          operatorAuthority: authority,
          scopes: ["operator.write"],
          requesterOrigin: undefined,
          signal: new AbortController().signal,
          assertCurrent: () => authority.signal?.throwIfAborted(),
          release() {},
          run,
          runWithRequester: run,
        };
        subagentRuns.set(runId, entry);
        subagentRuns.bindCompletionAuthority(entry, custody);
        return entry;
      };
      {
        const anchor = install("anchor", ceiling);
        const same = install("same", structuredClone(ceiling));
        const owner = install("owner", undefined);
        const narrower = install("narrower", { ...ceiling, tools: [] });
        const otherInvitation = install("other", {
          ...ceiling,
          source: { ...ceiling.source, sessionId: "different" },
        });
        expect(
          subagentRuns.selectCompletionAuthorityBatch(
            [anchor, same, owner, narrower, otherInvitation],
            anchor,
          ),
        ).toEqual([anchor, same]);
        subagentRuns.runWithCompletionBatchAuthority([anchor, same], effect);
        expect(effect).toHaveBeenCalledOnce();
        expect(retained).toHaveBeenCalledOnce();
        effect.mockClear();
        for (const other of [owner, narrower, otherInvitation]) {
          expect(() =>
            subagentRuns.runWithCompletionBatchAuthority([anchor, other], effect),
          ).toThrow(/stay current and separate/);
        }
        subagentRuns.releaseCompletionAuthority(anchor);
        expect(() => subagentRuns.runWithCompletionAuthority(anchor, effect)).toThrow(
          /original-source custody/,
        );
        expect(() => subagentRuns.runWithCompletionBatchAuthority([anchor, same], effect)).toThrow(
          /original-source custody/,
        );
        expect(effect).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["original", "successor"] as const)(
    "keeps completed-result and followup custody independent when the %s result is released",
    (releasedOwner) =>
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
          const releaseOriginal = releasedOwner === "original";
          await releaseSubagentRun(releaseOriginal ? retained.runId : successor.runId);
          expect(completionSource(releaseOriginal ? retained : successor)).toBeUndefined();
          expect(completionSource(releaseOriginal ? successor : retained)).toBe(
            releaseOriginal ? followup.authority.source : original.authority.source,
          );
          await releaseSubagentRun(entry.runId);
          await releaseSubagentRun(successor.runId);
          expect(subagentRuns.runWithCompletionAuthority(entry, () => "baseline")).toBe("baseline");
        } finally {
          original.release();
          followup?.release();
          await resetSubagentRegistryForTests({ persist: false });
        }
      }),
  );
}
