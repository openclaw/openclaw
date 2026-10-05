import { expect, it } from "vitest";
import { projectNoGoalInterruptedAction } from "../../config/sessions/main-session-recovery.types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

function heldEntry(): InternalSessionEntry {
  return {
    sessionId: "original-session",
    lifecycleRevision: "original-lifecycle",
    repositoryWorkspaceId: "original-workspace",
    updatedAt: 100,
    status: "interrupted",
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "original-run",
    restartRecoveryDeliverySourceRunId: "original-run",
    restartRecoveryRuns: [{ runId: "original-run", lifecycleGeneration: "old-generation" }],
    mainRestartRecovery: {
      cycleId: "original-cycle",
      revision: 2,
      chargedAttempts: 0,
      pause: {
        reason: "unverifiable-external-effect",
        pausedAtMs: 100,
        toolCallId: "original-call",
        toolName: "exec",
      },
      turnIntent: {
        sessionId: "original-session",
        sessionKey: "agent:main:dashboard:original",
        lifecycleRevision: "original-lifecycle",
        repositoryWorkspaceId: "original-workspace",
        runId: "original-run",
        inputId: "original-input",
        idempotencyKey: "original-run:user",
        lifecycleGeneration: "old-generation",
        issuer: {
          version: 1,
          profileId: "original-user",
          factoryActor: { host: "microsoft.ghe.com", accountId: 123 },
          assignedRole: "member",
          rolePolicyGeneration: "roles-1",
          aliasBindingIds: [],
          scopes: ["operator.write"],
          modelCeilings: [],
          device: { deviceId: "original-device", identity: "original-identity" },
          authPrincipal: {
            role: "operator",
            authMethod: "token",
            verifiedIdentity: "original-user",
          },
          authPolicyGeneration: "auth-1",
          sharedAuthGeneration: null,
          grant: null,
        },
      },
    },
  };
}

function decisionCommand() {
  return {
    kind: "acknowledge_pause" as const,
    now: 200,
    observation: { sessionId: "original-session", cycleId: "original-cycle", revision: 2 },
    noReplay: {
      sessionId: "original-session",
      lifecycleRevision: "original-lifecycle",
      cycleId: "original-cycle",
      revision: 2,
      pausedAtMs: 100,
      toolCallId: "original-call",
      runId: "original-run",
      profileId: "original-user",
      factoryActor: { host: "microsoft.ghe.com" as const, accountId: 123 },
    },
  };
}

it("acknowledges an unknown NoGoal outcome without making the original turn recoverable", () => {
  const entry = heldEntry();
  const command = decisionCommand();
  expect(transitionMainSessionRecovery(entry, command)).toEqual({ kind: "applied" });
  expect(entry.sessionId).toBe("original-session");
  expect(entry.repositoryWorkspaceId).toBe("original-workspace");
  expect(entry.abortedLastRun).toBe(false);
  expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
  expect(entry.restartRecoveryTerminalRunIds).toContain("original-run");
  expect(
    transitionMainSessionRecovery(entry, {
      kind: "inspect",
      lifecycleGeneration: "new-generation",
      sessionKey: "agent:main:dashboard:original",
    }),
  ).toEqual({ kind: "observed", view: { status: "inactive" } });
  expect(transitionMainSessionRecovery(entry, command)).toEqual({ kind: "no_change" });
  expect(projectNoGoalInterruptedAction(entry)).toBeUndefined();
  expect(
    projectMainSessionRecoveryLifecycle({
      entry,
      currentLifecycleGeneration: "new-generation",
      event: {
        runId: "original-run",
        lifecycleGeneration: "old-generation",
        data: { phase: "end" },
      },
      snapshotPatch: { status: "done" },
    }),
  ).toEqual({ action: "suppress" });
  expect(
    transitionMainSessionRecovery(entry, {
      kind: "claim_foreground",
      sessionId: entry.sessionId,
      sessionKey: "agent:main:dashboard:original",
      cycleId: "next-cycle",
      lifecycleGeneration: "new-generation",
      claimId: "next-claim",
      runId: "fresh-run",
    }),
  ).toEqual({ kind: "applied" });
  expect(entry.mainRestartRecovery).toBeUndefined();
  expect(entry.sessionId).toBe("original-session");
  expect(entry.repositoryWorkspaceId).toBe("original-workspace");
  expect(entry.restartRecoveryTerminalRunIds).toContain("original-run");
});

it.each([
  "foreign actor",
  "foreign account",
  "cycle",
  "revision",
  "call",
  "lifecycle",
  "run",
  "reservation",
  "writer",
  "foreign run",
  "missing issuer",
  "manual pause",
  "old foreground owner",
  "pending accepted input",
  "pause timestamp",
])("leaves the hold untouched for %s", (change) => {
  const entry = heldEntry();
  const command = decisionCommand();
  if (change === "foreign actor") {
    command.noReplay.profileId = "foreign-user";
  }
  if (change === "foreign account") {
    command.noReplay.factoryActor.accountId = 999;
  }
  if (change === "cycle") {
    command.noReplay.cycleId = "stale-cycle";
  }
  if (change === "revision") {
    command.noReplay.revision = 1;
  }
  if (change === "call") {
    command.noReplay.toolCallId = "another-call";
  }
  if (change === "lifecycle") {
    command.noReplay.lifecycleRevision = "old-lifecycle";
  }
  if (change === "run") {
    command.noReplay.runId = "another-run";
  }
  if (change === "reservation") {
    entry.mainRestartRecovery!.reservation = {
      runId: "reserved",
      attempt: 1,
      lifecycleGeneration: "old-generation",
    };
  }
  if (change === "writer") {
    entry.activeWriterRunId = "active-writer";
  }
  if (change === "foreign run") {
    entry.restartRecoveryRuns!.push({
      runId: "foreign-run",
      lifecycleGeneration: "old-generation",
    });
  }
  if (change === "missing issuer") {
    entry.mainRestartRecovery!.turnIntent = undefined;
  }
  if (change === "manual pause") {
    entry.goalPauseOrigin = "manual";
  }
  if (change === "old foreground owner") {
    entry.mainRestartRecovery!.foregroundClaims = {
      lifecycleGeneration: "old-generation",
      tokens: ["old-owner"],
    };
  }
  if (change === "pending accepted input") {
    entry.mainRestartRecovery!.queuedInputsPending = true;
  }
  if (change === "pause timestamp") {
    command.noReplay.pausedAtMs = 99;
  }
  const before = structuredClone(entry);
  expect(transitionMainSessionRecovery(entry, command).kind).toBe("rejected");
  expect(entry).toEqual(before);
});

it("projects review without issuer contents and never converts a hold into ordinary send admission", () => {
  const entry = heldEntry();
  expect(projectNoGoalInterruptedAction(entry)).toEqual({
    reason: "unverifiable-external-effect",
    toolCallId: "original-call",
    toolName: "exec",
    decision: {
      sessionId: "original-session",
      lifecycleRevision: "original-lifecycle",
      cycleId: "original-cycle",
      revision: 2,
      pausedAtMs: 100,
      toolCallId: "original-call",
      runId: "original-run",
    },
  });
  expect(
    transitionMainSessionRecovery(entry, {
      kind: "claim_foreground",
      sessionId: entry.sessionId,
      sessionKey: "agent:main:dashboard:original",
      lifecycleGeneration: "new-generation",
      cycleId: "unrelated-cycle",
      claimId: "new-claim",
    }),
  ).toEqual({ kind: "rejected", reason: "session_paused" });
});
