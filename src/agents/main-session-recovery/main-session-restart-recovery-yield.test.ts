// Real-path coverage for the restart-recovery discovery yield (#149935): timers
// queued before the scan must run between store probes instead of waiting for
// the combined length of every synchronous probe.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createSessionEntry,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery-runtime.js";
import { discoverRestartRecoveryStoreTargets } from "./main-session-restart-recovery-shared.js";
import * as recoveryStore from "./main-session-restart-recovery-store.js";

function runningMainSessionEntry(
  overrides: Partial<SessionEntryFixture> = {},
): ReturnType<typeof createSessionEntry> {
  return createSessionEntry({
    sessionId: "main-session",
    updatedAt: Date.now() - 10_000,
    status: "running",
    ...overrides,
  });
}

describe("restart recovery discovery yield", () => {
  it("lets timers queued before discovery run between store probes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-yield-"));
    try {
      const sessionsDirA = path.join(tmpDir, "agents", "yield-a", "sessions");
      const sessionsDirB = path.join(tmpDir, "agents", "yield-b", "sessions");
      await fs.mkdir(sessionsDirA, { recursive: true });
      await fs.mkdir(sessionsDirB, { recursive: true });
      const writeMainSession = async (sessionsDir: string, sessionKey: string) => {
        await sessionAccessor.replaceSessionEntry(
          { storePath: path.join(sessionsDir, "sessions.json"), sessionKey },
          runningMainSessionEntry(),
        );
      };
      await writeMainSession(sessionsDirA, "agent:yield-a:main");
      await writeMainSession(sessionsDirB, "agent:yield-b:main");
      const cfg = {
        agents: { list: [{ id: "yield-a", default: true }, { id: "yield-b" }] },
      } as OpenClawConfig;

      // Observation point: with two stores and a per-target yield, an immediate
      // queued after discovery starts must run while the scan is unsettled AND
      // exactly one probe has happened (between probe 1 and probe 2). A single
      // yield before all probes (or none) would leave probeCount at 0 or 2
      // respectively, so this pins the mid-scan interleaving (#149935 Rev 1).
      const probeSpy = vi.spyOn(sessionAccessor, "hasSessionEntriesByStatusReadOnly");
      let settled = false;
      let observedUnsettled = false;
      let observedProbes = -1;
      const pending = discoverRestartRecoveryStoreTargets({
        cfg,
        stateDir: tmpDir,
        statuses: ["running"],
      }).then((targets) => {
        settled = true;
        return targets;
      });
      setImmediate(() => {
        observedUnsettled = !settled;
        observedProbes = probeSpy.mock.calls.length;
      });
      const storeTargets = await pending;

      // The pre-scan timer must have run while discovery was still probing: the
      // probe chain yields one macrotask between targets instead of blocking for
      // the combined length of every store probe (#149935).
      expect(observedUnsettled).toBe(true);
      expect(observedProbes).toBe(1);
      expect(storeTargets).toContainEqual({
        agentId: "yield-a",
        storePath: path.join(sessionsDirA, "sessions.json"),
      });
      expect(storeTargets).toContainEqual({
        agentId: "yield-b",
        storePath: path.join(sessionsDirB, "sessions.json"),
      });
      probeSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("cancels between store probes without loading the next store", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-cancel-"));
    try {
      const sessionsDirA = path.join(tmpDir, "agents", "cancel-a", "sessions");
      const sessionsDirB = path.join(tmpDir, "agents", "cancel-b", "sessions");
      await fs.mkdir(sessionsDirA, { recursive: true });
      await fs.mkdir(sessionsDirB, { recursive: true });
      const writeMainSession = async (sessionsDir: string, sessionKey: string) => {
        await sessionAccessor.replaceSessionEntry(
          { storePath: path.join(sessionsDir, "sessions.json"), sessionKey },
          runningMainSessionEntry(),
        );
      };
      await writeMainSession(sessionsDirA, "agent:cancel-a:main");
      await writeMainSession(sessionsDirB, "agent:cancel-b:main");
      const cfg = {
        agents: { list: [{ id: "cancel-a", default: true }, { id: "cancel-b" }] },
      } as OpenClawConfig;

      const storeSpy = vi.spyOn(recoveryStore, "recoverStore");
      let shouldContinueCalls = 0;
      // Calls 1-4: discovery probes both stores (pre + post-status per store).
      // Call 5: the first target's pre-yield check passes. Call 6: the
      // post-yield recheck cancels, so store 1's recoverStore must never run —
      // this pins the recovery-yield guard specifically (#149935 Rev 2/4).
      const result = await recoverRestartAbortedMainSessions({
        cfg,
        stateDir: tmpDir,
        gatewayRuntime: {
          dispatchSessionMethod: vi.fn(),
          dispatchAgent: vi.fn(),
          waitForAgent: vi.fn(),
          sendRecoveryNotice: vi.fn(),
        } as unknown as Parameters<typeof recoverRestartAbortedMainSessions>[0]["gatewayRuntime"],
        shouldContinue: () => ++shouldContinueCalls <= 5,
      });

      expect(storeSpy).toHaveBeenCalledTimes(0);
      expect(result).toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
      storeSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stops discovery between store probes when cancellation lands", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-dstop-"));
    try {
      const sessionsDirA = path.join(tmpDir, "agents", "dstop-a", "sessions");
      const sessionsDirB = path.join(tmpDir, "agents", "dstop-b", "sessions");
      await fs.mkdir(sessionsDirA, { recursive: true });
      await fs.mkdir(sessionsDirB, { recursive: true });
      const writeMainSession = async (sessionsDir: string, sessionKey: string) => {
        await sessionAccessor.replaceSessionEntry(
          { storePath: path.join(sessionsDir, "sessions.json"), sessionKey },
          runningMainSessionEntry(),
        );
      };
      await writeMainSession(sessionsDirA, "agent:dstop-a:main");
      await writeMainSession(sessionsDirB, "agent:dstop-b:main");
      const cfg = {
        agents: { list: [{ id: "dstop-a", default: true }, { id: "dstop-b" }] },
      } as OpenClawConfig;

      const probeSpy = vi.spyOn(sessionAccessor, "hasSessionEntriesByStatusReadOnly");
      let shouldContinueCalls = 0;
      // Call 1: store A's pre-probe check passes; call 2 (its post-status
      // recheck) cancels — store B's probe must never run (#149935 Rev 3).
      const storeTargets = await discoverRestartRecoveryStoreTargets({
        cfg,
        stateDir: tmpDir,
        statuses: ["running"],
        shouldContinue: () => ++shouldContinueCalls <= 1,
      });

      expect(probeSpy).toHaveBeenCalledTimes(1);
      expect(storeTargets).toHaveLength(0);
      probeSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
