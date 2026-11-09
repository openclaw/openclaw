import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";
import {
  markOrphanedMainSessionForRecovery,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

// Regression coverage for #118873: a terminal-only mainRestartRecovery
// aggregate (every recorded run has a terminal fact; no reservation,
// foreground claim, or tombstone) must retire at foreground admission
// instead of blocking the session forever with "changed while starting work".

const sessionKey = "agent:main:main";
const unusedGatewayRuntime: GatewayRecoveryRuntime = {
  dispatchSessionMethod: async () => {
    throw new Error("terminal residue must not dispatch session methods");
  },
  dispatchAgent: async () => {
    throw new Error("terminal residue must not dispatch");
  },
  waitForAgent: async () => {
    throw new Error("terminal residue must not wait");
  },
  sendRecoveryNotice: async () => {
    throw new Error("terminal residue must not send a notice");
  },
};

function recoveryState(
  overrides: Partial<MainRestartRecoveryState> = {},
): MainRestartRecoveryState {
  return {
    cycleId: "cycle-1",
    revision: 1,
    chargedAttempts: 0,
    ...overrides,
  };
}

function settledEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    status: "running",
    abortedLastRun: false,
    mainRestartRecovery: recoveryState(),
    restartRecoveryRuns: [{ runId: "settled-run", lifecycleGeneration: "dead-generation" }],
    restartRecoveryTerminalRunIds: ["settled-run"],
    ...overrides,
  };
}

function claimForeground(entry: SessionEntry) {
  return transitionMainSessionRecovery(entry, {
    kind: "claim_foreground",
    cycleId: "unused",
    lifecycleGeneration: "generation-1",
    sessionId: "session-1",
    sessionKey,
    claimId: "foreground-1",
  });
}

describe("main session recovery terminal-only residue", () => {
  it("retires a terminal-only aggregate before healthy foreground admission", () => {
    const entry = settledEntry({
      restartRecoveryRuns: [
        { runId: "settled-run-1", lifecycleGeneration: "dead-generation-1" },
        { runId: "settled-run-2", lifecycleGeneration: "dead-generation-2" },
      ],
      restartRecoveryTerminalRunIds: ["settled-run-1", "settled-run-2"],
    });

    expect(claimForeground(entry)).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({ status: "running", abortedLastRun: false });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("keeps the aggregate when any run still lacks a terminal fact", () => {
    const entry = settledEntry({
      restartRecoveryRuns: [
        { runId: "settled-run", lifecycleGeneration: "dead-generation" },
        { runId: "live-run", lifecycleGeneration: "generation-1" },
      ],
    });

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry.mainRestartRecovery).toBeDefined();
    expect(entry.restartRecoveryRuns).toHaveLength(2);
  });

  it("keeps the aggregate while a reservation still owns work", () => {
    const entry = settledEntry({
      mainRestartRecovery: recoveryState({
        reservation: { lifecycleGeneration: "generation-1", runId: "reserved-run", attempt: 1 },
      }),
    });

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry.mainRestartRecovery?.reservation).toBeDefined();
  });

  it("keeps the aggregate while a foreground claim still owns work", () => {
    const entry = settledEntry({
      mainRestartRecovery: recoveryState({
        foregroundClaims: { lifecycleGeneration: "generation-1", tokens: ["existing-claim"] },
      }),
    });

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry.mainRestartRecovery?.foregroundClaims).toBeDefined();
  });

  it("keeps the aggregate while a delivery claim is still recorded", () => {
    const entry = settledEntry({ restartRecoveryDeliveryRunId: "pending-delivery" });

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry.mainRestartRecovery).toBeDefined();
    expect(entry.restartRecoveryDeliveryRunId).toBe("pending-delivery");
  });

  it("retires terminal-only residue through the persisted startup scan", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-residue-"));
    const storePath = path.join(tempDir, "sessions.json");
    try {
      await replaceSessionEntry({ sessionKey, storePath }, settledEntry());

      await expect(
        recoverStore({
          activeSessionIds: [],
          activeSessionKeys: [],
          gatewayRuntime: unusedGatewayRuntime,
          handledSessionKeys: new Set(),
          storePath,
        }),
      ).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });

      const entry = loadSessionEntry({ readConsistency: "latest", sessionKey, storePath });
      expect(entry?.mainRestartRecovery).toBeUndefined();
      expect(entry?.restartRecoveryRuns).toBeUndefined();
    } finally {
      await cleanupSessionStateForTest({ stateDir: tempDir });
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("retires terminal residue before orphan marking without touching a current owner", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-marking-"));
    const storePath = path.join(tempDir, "sessions.json");
    const liveSessionKey = "agent:main:live";
    const startupCheckedStorePaths = new Set<string>();
    try {
      await replaceSessionEntry({ sessionKey, storePath }, settledEntry());
      await replaceSessionEntry(
        { sessionKey: liveSessionKey, storePath },
        settledEntry({
          sessionId: "live-session",
          restartRecoveryDeliveryRunId: "live-run",
          restartRecoveryRuns: [{ runId: "live-run", lifecycleGeneration: "current-generation" }],
          restartRecoveryTerminalRunIds: [],
        }),
      );

      await expect(
        markStartupOrphanedMainSessionsForRecovery({
          activeSessionIds: ["live-session"],
          activeSessionKeys: [],
          cfg: { session: { store: storePath } },
          stateDir: tempDir,
          startupCheckedStorePaths,
        }),
      ).resolves.toEqual({ marked: 0, skipped: 1 });
      await expect(
        markStartupOrphanedMainSessionsForRecovery({
          cfg: { session: { store: storePath } },
          stateDir: tempDir,
          startupCheckedStorePaths,
        }),
      ).resolves.toEqual({ marked: 0, skipped: 0 });

      const terminal = loadSessionEntry({ readConsistency: "latest", sessionKey, storePath });
      const live = loadSessionEntry({
        readConsistency: "latest",
        sessionKey: liveSessionKey,
        storePath,
      });
      expect(terminal?.mainRestartRecovery).toBeUndefined();
      expect(terminal?.restartRecoveryRuns).toBeUndefined();
      expect(live).toMatchObject({
        sessionId: "live-session",
        restartRecoveryDeliveryRunId: "live-run",
        restartRecoveryRuns: [{ runId: "live-run" }],
      });
    } finally {
      await cleanupSessionStateForTest({ stateDir: tempDir });
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("does not block standalone inspect admission on terminal-only residue", () => {
    const entry = settledEntry();

    const result = transitionMainSessionRecovery(entry, {
      kind: "inspect",
      lifecycleGeneration: "standalone-generation",
      sessionKey,
    });

    expect(result).toMatchObject({ kind: "observed", view: { status: "inactive" } });
  });

  it("keeps blocking standalone inspect admission on a live recovery fence", () => {
    const entry = settledEntry({
      restartRecoveryRuns: [
        { runId: "settled-run", lifecycleGeneration: "dead-generation" },
        { runId: "live-run", lifecycleGeneration: "generation-1" },
      ],
    });

    const result = transitionMainSessionRecovery(entry, {
      kind: "inspect",
      lifecycleGeneration: "standalone-generation",
      sessionKey,
    });

    expect(result).toMatchObject({ kind: "observed", view: { status: "blocked" } });
  });
  it.each([false, true])(
    "releases ownerless killed fences before foreground admission (aborted=%s)",
    async (abortedLastRun) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-killed-admission-"));
      const storePath = path.join(tempDir, "sessions.json");
      try {
        await replaceSessionEntry(
          { sessionKey, storePath },
          settledEntry({
            status: "killed",
            abortedLastRun,
            mainRestartRecovery: undefined,
            restartRecoveryTerminalRunIds: [],
          }),
        );
        await expect(
          markOrphanedMainSessionForRecovery({
            target: { agentId: "main", sessionKey, storePath },
            expectedSessionId: "session-1",
          }),
        ).resolves.toMatchObject({ marked: 0, skipped: 1 });
        const entry = loadSessionEntry({ readConsistency: "latest", sessionKey, storePath });
        expect(entry).toMatchObject({ status: "killed", abortedLastRun: false });
        expect(entry?.restartRecoveryRuns).toBeUndefined();
        expect(entry?.mainRestartRecovery).toBeUndefined();
      } finally {
        await cleanupSessionStateForTest({ stateDir: tempDir });
        await fs.rm(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("finds killed-only stores at startup without clearing live, delivery, reservation or tombstone owners", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-killed-startup-"));
    const storePath = path.join(tempDir, "sessions.json");
    let admission: SessionWorkAdmissionLease | undefined;
    const entries: Record<string, SessionEntry> = {
      released: settledEntry({
        status: "killed",
        abortedLastRun: true,
        mainRestartRecovery: undefined,
        restartRecoveryTerminalRunIds: [],
      }),
      live: settledEntry({
        sessionId: "live-session",
        status: "killed",
        mainRestartRecovery: undefined,
        restartRecoveryTerminalRunIds: [],
      }),
      pending: settledEntry({
        status: "killed",
        pendingFinalDelivery: { kind: "replayable", text: "pending", createdAt: 1 },
      }),
      delivery: settledEntry({ status: "killed", restartRecoveryDeliveryRunId: "delivery-owner" }),
      harness: settledEntry({
        status: "killed",
        restartRecoveryHarnessCompletion: {
          taskId: "task",
          taskStatus: "succeeded",
          taskRunId: "task-run",
          sourceRunId: "source",
          requesterSessionKey: "agent:main:harness",
          requesterAgentId: "main",
          sessionId: "session-1",
        },
      }),
      reserved: settledEntry({
        status: "killed",
        mainRestartRecovery: recoveryState({
          reservation: { lifecycleGeneration: "current", runId: "reserved", attempt: 1 },
        }),
      }),
      foreground: settledEntry({
        status: "killed",
        mainRestartRecovery: recoveryState({
          foregroundClaims: { lifecycleGeneration: "current", tokens: ["owner"] },
        }),
      }),
      tombstone: settledEntry({
        status: "killed",
        mainRestartRecovery: recoveryState({ tombstone: { reason: "exhausted" } }),
      }),
    };
    try {
      for (const [name, entry] of Object.entries(entries)) {
        entry.restartRecoveryTerminalRunIds = [];
        await replaceSessionEntry({ sessionKey: "agent:main:" + name, storePath }, entry);
      }
      // A real session lease can outlive agent/embedded registration.
      admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: ["agent:main:live", "live-session"],
        assertAllowed: () => {},
      });
      expect(isSessionWorkAdmissionActive(storePath, ["agent:main:live", "live-session"])).toBe(
        true,
      );
      await expect(
        markStartupOrphanedMainSessionsForRecovery({
          cfg: { session: { store: storePath } },
          stateDir: tempDir,
          activeSessionIds: [],
          activeSessionKeys: [],
        }),
      ).resolves.toMatchObject({ marked: 0, skipped: 1 });
      for (const [name, original] of Object.entries(entries)) {
        const entry = loadSessionEntry({
          readConsistency: "latest",
          sessionKey: "agent:main:" + name,
          storePath,
        });
        if (name === "released") {
          expect(entry?.status).toBe("killed");
          expect(entry?.restartRecoveryRuns).toBeUndefined();
          expect(entry?.mainRestartRecovery).toBeUndefined();
        } else {
          expect(entry?.status).toBe(original.status);
          expect(entry?.abortedLastRun).toBe(original.abortedLastRun);
          expect(entry?.restartRecoveryRuns).toEqual(original.restartRecoveryRuns);
          expect(entry?.mainRestartRecovery).toEqual(original.mainRestartRecovery);
          expect(entry?.pendingFinalDelivery).toEqual(original.pendingFinalDelivery);
          expect(entry?.restartRecoveryDeliveryRunId).toBe(original.restartRecoveryDeliveryRunId);
          expect(entry?.restartRecoveryHarnessCompletion).toEqual(
            original.restartRecoveryHarnessCompletion,
          );
        }
      }
      admission.release();
      expect(isSessionWorkAdmissionActive(storePath, ["agent:main:live", "live-session"])).toBe(
        false,
      );
      await expect(
        markOrphanedMainSessionForRecovery({
          target: { agentId: "main", sessionKey: "agent:main:live", storePath },
          expectedSessionId: "live-session",
        }),
      ).resolves.toEqual({ marked: 0, skipped: 1 });
      const released = loadSessionEntry({
        readConsistency: "latest",
        sessionKey: "agent:main:live",
        storePath,
      });
      expect(released?.status).toBe("killed");
      expect(released?.restartRecoveryRuns).toBeUndefined();
      expect(released?.mainRestartRecovery).toBeUndefined();
    } finally {
      admission?.release();
      await cleanupSessionStateForTest({ stateDir: tempDir });
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("rechecks a real session work lease acquired after killed-fence planning", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-killed-lease-commit-"));
    const storePath = path.join(tempDir, "sessions.json");
    let admission: SessionWorkAdmissionLease | undefined;
    const apply = sessionAccessor.applySessionEntryReplacements;
    let restoreSpy = () => {};
    try {
      await replaceSessionEntry(
        { sessionKey, storePath },
        settledEntry({
          status: "killed",
          abortedLastRun: true,
          mainRestartRecovery: undefined,
          restartRecoveryTerminalRunIds: [],
        }),
      );
      const before = loadSessionEntry({ readConsistency: "latest", sessionKey, storePath });
      const spy = vi
        .spyOn(sessionAccessor, "applySessionEntryReplacements")
        .mockImplementationOnce((params) =>
          apply({
            ...params,
            update: async (entries) => {
              const prepared = await params.update(entries);
              // No agent or embedded run exists: only this actual admission owns the session.
              // Acquire by session ID alone to exercise the second durable identity.
              admission = await beginSessionWorkAdmission({
                scope: storePath,
                identities: ["session-1"],
                assertAllowed: () => {},
              });
              return prepared;
            },
          }),
        );
      restoreSpy = () => spy.mockRestore();
      const reconcile = () =>
        markOrphanedMainSessionForRecovery({
          target: { agentId: "main", sessionKey, storePath },
          expectedSessionId: "session-1",
        });
      await expect(reconcile()).rejects.toThrow(
        "Startup orphan acquired a live owner before recovery commit",
      );
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, "session-1"])).toBe(true);
      expect(loadSessionEntry({ readConsistency: "latest", sessionKey, storePath })).toEqual(
        before,
      );
      restoreSpy();
      admission?.release();
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, "session-1"])).toBe(false);
      await expect(reconcile()).resolves.toEqual({ marked: 0, skipped: 1 });
      const released = loadSessionEntry({ readConsistency: "latest", sessionKey, storePath });
      expect(released?.status).toBe("killed");
      expect(released?.restartRecoveryRuns).toBeUndefined();
      expect(released?.mainRestartRecovery).toBeUndefined();
    } finally {
      restoreSpy();
      admission?.release();
      await cleanupSessionStateForTest({ stateDir: tempDir });
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });
});
