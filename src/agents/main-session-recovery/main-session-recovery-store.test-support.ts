import path from "node:path";
import { afterAll, expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../test-utils/session-state-cleanup.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";

/** Shared database lifecycle for recovery-store admission cases. */
export function createMainSessionRecoveryStoreFixture() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      for (const stateDir of tempDirs.dirs) {
        await cleanupSessionStateForTest({ stateDir });
      }
      cleanup();
    }),
  );
  const stores = new Map<string, string>();
  let isolatedStoreDir: string | undefined;

  return {
    fixtureStore: (agentId = "main"): string => {
      let fixturePath = stores.get(agentId);
      if (!fixturePath) {
        fixturePath = path.join(tempDirs.make("openclaw-main-recovery-store-"), "sessions.json");
        stores.set(agentId, fixturePath);
      }
      return fixturePath;
    },
    createMovedSessionStore: (): string => {
      isolatedStoreDir = tempDirs.make("openclaw-main-recovery-moved-store-");
      return path.join(isolatedStoreDir, "sessions.json");
    },
    resetCase: async (): Promise<void> => {
      if (isolatedStoreDir) {
        // Moved-window layouts are recovery inputs, not canonical cleanup projections.
        await cleanupSessionStateForTest({ stateDir: isolatedStoreDir });
        isolatedStoreDir = undefined;
      }
      for (const [agentId, storePath] of stores) {
        const stateDir = path.dirname(storePath);
        await drainSessionStateForTest({ stateDir });
        await applySessionEntryLifecycleMutation({
          agentId,
          storePath,
          // Reused IDs need their physical windows removed, not retained alias nodes.
          removals: listSessionEntriesCore({ agentId, storePath }).map(({ sessionKey }) => ({
            sessionKey,
            deleteOwnedWindows: true,
          })),
          skipMaintenance: true,
        });
        await drainSessionStateForTest({ stateDir });
      }
    },
  };
}

export async function exerciseProviderWaitCompatibility(params: {
  change:
    | "known"
    | "unsupported"
    | "missing-environment"
    | "mixed"
    | "started"
    | "different-run"
    | "different-attempt";
  sessionId: string;
  sessionKey: string;
  storePath: string;
  runId: string;
}) {
  const { change, sessionId, sessionKey, storePath, runId } = params;
  const generation = getAgentEventLifecycleGeneration();
  const provider = {
    kind: "settled-shortage-v1" as const,
    environmentId: "settled-environment",
    ownerEpoch: 4,
    placementGeneration: 2,
    providerId: "crabbox",
    profileId: "development",
    operationId: "exact-operation",
    leaseId: "exact-lease",
    attemptName: "fixed-vm",
    attemptNonce: "fixed-nonce",
    providerCode: "AllocationFailed",
    attempt: 2,
  };
  const marked = await commitMainSessionRecovery({
    target: { sessionKey, storePath },
    command: {
      kind: "wait_provider_capacity",
      sessionId,
      cycleId: "cycle-capacity",
      runId,
      lifecycleGeneration: generation,
      now: 100,
      provider,
    },
  });
  expect(marked.transition.kind).toBe("applied");
  const current = loadSessionEntry({ sessionKey, storePath })!;
  if (change === "unsupported") {
    Object.assign(current.mainRestartRecovery!.capacityWait!.provider!, {
      kind: "future-shortage",
    });
  }
  if (change === "missing-environment") {
    Object.assign(current.mainRestartRecovery!.capacityWait!.provider!, { environmentId: "" });
  }
  if (change === "mixed") {
    Object.assign(current.mainRestartRecovery!.capacityWait!, { worker: {} });
  }
  if (change === "started") {
    current.mainRestartRecovery!.startedAttempt = 2;
  }
  if (change === "different-run") {
    current.lifecycleRunId = "other-run";
  }
  if (change === "different-attempt") {
    current.mainRestartRecovery!.chargedAttempts = 3;
  }
  await replaceSessionEntry({ sessionKey, storePath }, current);
  await cleanupSessionStateForTest({ stateDir: path.dirname(storePath) });
  const reopened = loadSessionEntry({ sessionKey, storePath })!;
  expect(reopened.mainRestartRecovery?.capacityWait).toEqual(
    current.mainRestartRecovery?.capacityWait,
  );
  await commitMainSessionRecovery({
    target: { sessionKey, storePath },
    command: { kind: "mark_interrupted", cycleId: "unused", now: 200 },
  });
  const expected = change === "known" ? 1 : current.mainRestartRecovery!.chargedAttempts;
  expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.chargedAttempts).toBe(
    expected,
  );
  if (change === "unsupported" || change === "missing-environment" || change === "mixed") {
    const opaque = loadSessionEntry({ sessionKey, storePath })!;
    const observed = await commitMainSessionRecovery({
      target: { sessionKey, storePath },
      command: {
        kind: "observe",
        cycleId: "unused",
        sessionKey,
        lifecycleGeneration: generation,
      },
    });
    expect(observed.transition).toMatchObject({
      kind: "observed",
      view: { status: "blocked" },
    });
    const attempted = await commitMainSessionRecovery({
      target: { sessionKey, storePath },
      command: {
        kind: "prepare_attempt",
        attempt: expected + 1,
        lifecycleGeneration: generation,
        runId: "must-not-dispatch",
        now: 400,
        observation: {
          sessionId,
          cycleId: opaque.mainRestartRecovery!.cycleId,
          revision: opaque.mainRestartRecovery!.revision,
        },
        executionIdentity: { state: "disabled" },
      },
    });
    expect(attempted.transition.kind).toBe("rejected");
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery).toEqual(
      opaque.mainRestartRecovery,
    );
  }
  await commitMainSessionRecovery({
    target: { sessionKey, storePath },
    command: { kind: "mark_interrupted", cycleId: "unused", now: 300 },
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.chargedAttempts).toBe(
    expected,
  );
}
