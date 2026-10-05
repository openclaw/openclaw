import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { createOriginalIssuerFixture } from "./main-session-recovery-original-issuer.test-support.js";
import type { MainSessionRecoveryCounts } from "./main-session-restart-dispatch.types.js";

export const retiredOriginalSourceChanges = [
  "current grant",
  "role revoked",
  "device removed",
  "manual pause",
  "unknown effect",
  "actor mismatch",
  "SID changed",
  "lifecycle changed",
] as const;

/** Exercise the terminal writer after restart owns an accepted pre-start input. */
export async function retireOriginalAcceptedSourceFence(
  target: { agentId: string; sessionKey: string },
  runId: string,
  source: boolean | "conflicting",
) {
  const original = expectDefined(loadSessionEntry(target), "original acceptance");
  await persistGatewaySessionLifecycleEvent({
    ...target,
    event: {
      runId,
      sessionId: original.sessionId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      ts: Date.now(),
      data: { phase: "error", error: "Synthetic pre-start settlement" },
    },
  });
  const retained = expectDefined(loadSessionEntry(target), "retained acceptance");
  expect(retained).toMatchObject({ status: "interrupted", abortedLastRun: true });
  expect(retained.mainRestartRecovery?.turnIntent).toEqual(
    original.mainRestartRecovery?.turnIntent,
  );
  expect(retained.restartRecoveryRuns).toBeUndefined();
  expect(retained.lifecycleRunId).toBeUndefined();
  expect(retained.restartRecoveryDeliverySourceRunId).toBeUndefined();
  expect(retained.restartRecoveryDeliveryRunId).toBeUndefined();
  if (source === "conflicting") {
    // A conflicting claim is an independent refusal, even with valid original custody.
    await replaceSessionEntry(target, {
      ...retained,
      restartRecoveryDeliverySourceRunId: "unrelated-source",
    });
  }
}

/** Diagnostics intentionally omit the private original issuer carried by an authority hold. */
export function assertOriginalSourceRecoveryEffects(params: {
  change: string;
  resumed: boolean;
  effects: number;
  counts?: MainSessionRecoveryCounts;
  warnings: string[];
  source: boolean | "conflicting";
  fixture: Pick<
    Awaited<ReturnType<typeof createOriginalIssuerFixture>>,
    "usesGrant" | "resumeGrant" | "grant" | "profile"
  >;
}) {
  const { counts, fixture } = params;
  expect(
    params.effects,
    JSON.stringify({
      change: params.change,
      counts: counts && {
        started: counts.started,
        settled: counts.settled,
        failed: counts.failed,
        skipped: counts.skipped,
        authorityHold: counts.authorityHold?.reason,
      },
      warnings: params.warnings,
    }),
  ).toBe(params.resumed ? 1 : 0);
  if (params.source === "conflicting") {
    expect(counts?.authorityHold?.reason).toBe("source-mismatch");
    expect(fixture.resumeGrant).not.toHaveBeenCalled();
  } else if (fixture.usesGrant) {
    expect(fixture.resumeGrant, params.change).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: fixture.grant.grantId,
        profile: expect.objectContaining({ profileId: fixture.profile.id }),
      }),
    );
  }
}

export async function commitOriginalAcceptedInput(
  recorder: UserTurnTranscriptRecorder | undefined,
) {
  expect(await expectDefined(recorder, "accepted input recorder").persistApproved()).toBeDefined();
}
