import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { transitionMainSessionRecovery as transition } from "./main-session-recovery-state.js";
import { claimForeground, recoveryEntry } from "./main-session-recovery-state.test-support.js";
import { markStartupOrphanedMainSessionsForRecovery as markOrphans } from "./main-session-restart-recovery-marking.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

// #118873: terminal-only custody must not block foreground admission forever.

const sessionKey = "agent:main:main";
function expectRetired(entry: SessionEntry | undefined) {
  expect(entry).toBeDefined();
  expect(entry?.mainRestartRecovery).toBeUndefined();
  expect(entry?.restartRecoveryRuns).toBeUndefined();
}
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const unexpectedRuntimeCall = async (): Promise<never> => {
  throw new Error("terminal residue must not dispatch, wait, or send a notice");
};
const unusedGatewayRuntime: GatewayRecoveryRuntime = {
  prepareRestartRecovery: () => undefined,
  dispatchSessionMethod: unexpectedRuntimeCall,
  dispatchAgent: unexpectedRuntimeCall,
  waitForAgent: unexpectedRuntimeCall,
  sendRecoveryNotice: unexpectedRuntimeCall,
};

function settledEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return recoveryEntry({
    restartRecoveryRuns: [{ runId: "settled-run", lifecycleGeneration: "dead-generation" }],
    restartRecoveryTerminalRunIds: ["settled-run"],
    ...overrides,
  });
}

function fencedEntry(live: boolean) {
  return settledEntry({
    restartRecoveryRuns: [
      { runId: "settled-run", lifecycleGeneration: "dead-generation" },
      { runId: "second-run", lifecycleGeneration: live ? "generation-1" : "dead-generation-2" },
    ],
    restartRecoveryTerminalRunIds: live ? ["settled-run"] : ["settled-run", "second-run"],
  });
}

async function withStore(run: (store: ReturnType<typeof createStore>) => Promise<void>) {
  const store = createStore();
  try {
    await run(store);
  } finally {
    await cleanupSessionStateForTest({ stateDir: store.stateDir });
  }
}

function createStore() {
  const stateDir = tempDirs.make("openclaw-terminal-residue-");
  const storePath = path.join(stateDir, "sessions.json");
  return {
    stateDir,
    storePath,
    read: (key = sessionKey) =>
      loadSessionEntry({ sessionKey: key, storePath, readConsistency: "latest" }),
    write: (entry: SessionEntry, key = sessionKey) =>
      replaceSessionEntry({ sessionKey: key, storePath }, entry),
    mark: (options: Parameters<typeof markOrphans>[0] = {}) =>
      markOrphans({ cfg: { session: { store: storePath } }, stateDir, ...options }),
  };
}

function unfinishedEntry(overrides: Partial<SessionEntry> = {}) {
  return settledEntry({
    lastRunId: "rejected-foreground",
    restartRecoveryDeliveryRunId: "rejected-foreground",
    restartRecoveryDeliverySourceRunId: "rejected-foreground",
    restartRecoveryRuns: [{ runId: "older-recovery", lifecycleGeneration: "dead-generation" }],
    restartRecoveryTerminalRunIds: ["rejected-foreground"],
    ...overrides,
  });
}

describe("main session recovery terminal-only residue", () => {
  it.each([false, true])(
    "retires foreground residue only if every fence is terminal (%s)",
    (live) => {
      const entry = fencedEntry(live);
      expect(claimForeground(entry)).toEqual({ kind: live ? "no_change" : "applied" });
      if (live) {
        expect(entry.mainRestartRecovery).toBeDefined();
        expect(entry.restartRecoveryRuns).toHaveLength(2);
      } else {
        expect(entry.abortedLastRun).toBe(false);
        expect(entry.status).toBeUndefined();
        expectRetired(entry);
      }
    },
  );

  it.each([false, true])(
    "requires every recovery fence to be terminal before retiring a later failed outcome (terminal=%s)",
    (terminal) => {
      const entry = unfinishedEntry({
        status: "failed",
        restartRecoveryTerminalRunIds: terminal
          ? ["older-recovery", "rejected-foreground"]
          : ["rejected-foreground"],
      });
      const before = structuredClone(entry);

      transition(entry, {
        kind: "observe",
        cycleId: "unused-cycle",
        lifecycleGeneration: "generation-1",
        sessionKey,
      });

      if (terminal) {
        expect(entry.status).toBe("failed");
        expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
        expectRetired(entry);
      } else {
        expect(entry).toEqual(before);
      }
    },
  );

  it("marks failed or statusless custody without reviving done or killed work", async () => {
    const cases = [undefined, "failed", "done", "killed"] as const;
    const before = new Map<string, SessionEntry>();
    await withStore(async ({ storePath, read, write, mark }) => {
      for (const status of cases) {
        const key = `agent:main:${status ?? "statusless"}`;
        await write(unfinishedEntry({ status }), key);
        before.set(
          key,
          expectDefined(loadSessionEntry({ sessionKey: key, storePath }), "seeded recovery entry"),
        );
      }

      await expect(mark()).resolves.toEqual({ marked: 2, skipped: 0 });

      for (const status of cases) {
        const key = `agent:main:${status ?? "statusless"}`;
        const entry = read(key);
        if (status === "done" || status === "killed") {
          expect(entry).toEqual(before.get(key));
        } else {
          expect(entry).toMatchObject({
            abortedLastRun: true,
            mainRestartRecovery: { cycleId: "cycle-1" },
            restartRecoveryRuns: before.get(key)?.restartRecoveryRuns,
          });
        }
      }
    });
  });

  it.each(["terminal-only", "failed", "killed", "failed-with-delivery"] as const)(
    "settles %s custody through persisted startup recovery",
    async (outcome) => {
      const initialEntry: SessionEntry =
        outcome === "terminal-only"
          ? settledEntry()
          : {
              sessionId: "retryable-session",
              updatedAt: 100,
              status: outcome === "failed-with-delivery" ? "failed" : outcome,
              abortedLastRun: false,
              restartRecoveryDeliveryRunId: "unadopted-run",
              restartRecoveryDeliverySourceRunId: "unadopted-run",
              restartRecoveryDeliveryRequestFingerprint: "accepted-request",
              restartRecoverySourceIngress: "control-ui",
            };
      if (outcome === "failed-with-delivery") {
        initialEntry.pendingFinalDelivery = {
          kind: "replayable",
          text: "An older source still owns this delivery",
          createdAt: 100,
        };
      }
      await withStore(async ({ storePath, read, write, mark }) => {
        await write(initialEntry);

        await expect(
          recoverStore({
            gatewayRuntime: unusedGatewayRuntime,
            handledSessionKeys: new Set(),
            storePath,
          }),
        ).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });

        const entry = read();
        expectRetired(entry);
        if (outcome !== "terminal-only") {
          expect(entry).toMatchObject(initialEntry);
          expect(entry?.restartRecoveryTerminalRunIds).toBeUndefined();
        }
        await expect(mark()).resolves.toEqual({
          marked: Number(outcome === "failed-with-delivery"),
          skipped: 0,
        });
        const marked = read();
        if (outcome === "failed-with-delivery") {
          expect(marked).toMatchObject({
            ...initialEntry,
            abortedLastRun: true,
            updatedAt: expect.any(Number),
          });
          expect(marked?.mainRestartRecovery).toBeDefined();
        } else {
          expect(marked).toEqual(entry);
        }
      });
    },
  );

  it("retires terminal residue before orphan marking without touching a current owner", async () => {
    const liveSessionKey = "agent:main:live";
    const startupCheckedStorePaths = new Set<string>();
    await withStore(async ({ storePath, read, write, mark }) => {
      await write(settledEntry());
      await write(
        settledEntry({
          sessionId: "live-session",
          restartRecoveryDeliveryRunId: "live-run",
          restartRecoveryRuns: [{ runId: "live-run", lifecycleGeneration: "current-generation" }],
          restartRecoveryTerminalRunIds: [],
        }),
        liveSessionKey,
      );

      const liveWork = await beginSessionEffect({
        scope: storePath,
        identities: [liveSessionKey, "live-session"],
        assertAllowed: () => {},
      });
      try {
        await expect(mark({ startupCheckedStorePaths })).resolves.toEqual({
          marked: 0,
          skipped: 1,
        });
      } finally {
        liveWork.release();
      }
      await expect(mark({ startupCheckedStorePaths })).resolves.toEqual({ marked: 0, skipped: 0 });

      const terminal = read();
      const live = read(liveSessionKey);
      expectRetired(terminal);
      expect(live).toMatchObject({
        sessionId: "live-session",
        restartRecoveryDeliveryRunId: "live-run",
        restartRecoveryRuns: [{ runId: "live-run" }],
      });
    });
  });

  it.each([false, true])("standalone inspect blocks only live recovery fences (%s)", (live) => {
    const entry = live ? fencedEntry(true) : settledEntry();

    const result = transition(entry, {
      kind: "inspect",
      lifecycleGeneration: "standalone-generation",
      sessionKey,
    });

    expect(result).toMatchObject({
      kind: "observed",
      view: { status: live ? "blocked" : "inactive" },
    });
  });
});
