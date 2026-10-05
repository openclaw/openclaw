// Real-path coverage for the restart-recovery discovery/recovery yield (#149935):
// timers queued before the scan run between store probes, cancellation stops the
// scan between probes, and the recovery loop's post-yield guard is pinned.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createSessionEntry,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery-runtime.js";
import { discoverRestartRecoveryStoreTargets } from "./main-session-restart-recovery-shared.js";
import * as recoveryStore from "./main-session-restart-recovery-store.js";

let tmpRoot = "";

async function makeStore(agentId: string): Promise<string> {
  const sessionsDir = path.join(tmpRoot, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const entry: SessionEntryFixture = {
    sessionId: `${agentId}-main`,
    updatedAt: Date.now() - 10_000,
    status: "running",
  };
  await sessionAccessor.replaceSessionEntry(
    { storePath, sessionKey: `agent:${agentId}:main` },
    createSessionEntry(entry),
  );
  return storePath;
}

function twoStoreConfig(): OpenClawConfig {
  return {
    agents: { list: [{ id: "yield-a", default: true }, { id: "yield-b" }] },
  } as OpenClawConfig;
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-yield-"));
  await makeStore("yield-a");
  await makeStore("yield-b");
  await makeStore("cancel-a");
  await makeStore("cancel-b");
  await makeStore("dstop-a");
  await makeStore("dstop-b");
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("restart recovery discovery yield", () => {
  it("lets timers observe the scan between store probes", async () => {
    const cfg = twoStoreConfig();
    const realProbe = sessionAccessor.hasSessionEntriesByStatusReadOnly;
    let unsettledMidScanTurns = 0;
    let settled = false;
    // When probe 1 completes, queue an observer for the next macrotasks: on
    // the fixed head one lands inside the inter-probe boundary (one probe
    // done, the second not started). A base whose probe chain never yields
    // runs every observer after the scan settles.
    const probeSpy = vi
      .spyOn(sessionAccessor, "hasSessionEntriesByStatusReadOnly")
      .mockImplementation((...args: unknown[]) => {
        const result = realProbe(...(args as Parameters<typeof realProbe>));
        if (probeSpy.mock.calls.length === 1) {
          setImmediate(() => {
            if (!settled && probeSpy.mock.calls.length === 1) {
              unsettledMidScanTurns += 1;
            }
          });
        }
        return result;
      });

    const storeTargets = await discoverRestartRecoveryStoreTargets({
      cfg,
      stateDir: tmpRoot,
      statuses: ["running"],
    });
    settled = true;

    expect(unsettledMidScanTurns).toBeGreaterThan(0);
    expect(storeTargets).toHaveLength(2);
    probeSpy.mockRestore();
  });

  it("cancels at the recovery yield without loading the next store", async () => {
    const cfg = {
      agents: { list: [{ id: "yield-a", default: true }, { id: "yield-b" }] },
    } as OpenClawConfig;
    const realRecoverStore = recoveryStore.recoverStore;
    const storeSpy = vi.spyOn(recoveryStore, "recoverStore");
    let shouldContinueCalls = 0;
    let cancelled = false;
    // Discovery consumes six calls on the two-store fixture (pre + post-status
    // per store). Call 7 is the first target's pre-yield check — queue the
    // cancellation there so it lands inside the recovery yield, and the
    // post-yield recheck stops the loop before store 1's recoverStore
    // (#149935 Rev 2/5). Without that guard the store loads synchronously.
    const result = await recoverRestartAbortedMainSessions({
      cfg,
      stateDir: tmpRoot,
      gatewayRuntime: {
        dispatchSessionMethod: vi.fn(),
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(),
        sendRecoveryNotice: vi.fn(),
      } as unknown as Parameters<typeof recoverRestartAbortedMainSessions>[0]["gatewayRuntime"],
      shouldContinue: () => {
        const call = ++shouldContinueCalls;
        if (call === 7) {
          setImmediate(() => {
            cancelled = true;
          });
        }
        return !cancelled;
      },
    });

    expect(cancelled).toBe(true);
    expect(storeSpy).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
    storeSpy.mockRestore();
  });

  it("stops discovery before any probe when cancellation is already set", async () => {
    const cfg = {
      agents: { list: [{ id: "cancel-a", default: true }, { id: "cancel-b" }] },
    } as OpenClawConfig;
    const probeSpy = vi.spyOn(sessionAccessor, "hasSessionEntriesByStatusReadOnly");
    // Deterministic slice: cancellation already set at entry stops discovery
    // before any store probe. The between-probe cancellation timing is
    // environment-dependent (worker-backed status probes) and is covered by
    // inspection; the recovery-yield guard is pinned by the previous test
    // (#149935 Rev 3/5).
    const storeTargets = await discoverRestartRecoveryStoreTargets({
      cfg,
      stateDir: tmpRoot,
      statuses: ["running"],
      shouldContinue: () => false,
    });

    expect(probeSpy).toHaveBeenCalledTimes(0);
    expect(storeTargets).toHaveLength(0);
    probeSpy.mockRestore();
  });
});
