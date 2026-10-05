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

      // Observation: with two stores and per-target macrotask boundaries, timers
      // queued before the scan must observe at least one event-loop turn while
      // the scan is still unsettled (#149935).
      let settled = false;
      let unsettledTurns = 0;
      const pending = discoverRestartRecoveryStoreTargets({
        cfg,
        stateDir: tmpDir,
        statuses: ["running"],
      }).then((targets) => {
        settled = true;
        return targets;
      });
      const observe = () => {
        if (!settled) {
          unsettledTurns += 1;
        }
      };
      setImmediate(observe);
      setImmediate(observe);
      setImmediate(observe);
      const storeTargets = await pending;

      expect(unsettledTurns).toBeGreaterThan(0);
      expect(storeTargets).toContainEqual({
        agentId: "yield-a",
        storePath: path.join(sessionsDirA, "sessions.json"),
      });
      expect(storeTargets).toContainEqual({
        agentId: "yield-b",
        storePath: path.join(sessionsDirB, "sessions.json"),
      });
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

      let callsAtFirstRecoverStore = -1;
      let shouldContinueCalls = 0;
      const storeSpy = vi.spyOn(recoveryStore, "recoverStore");
      // Discovery consumes 8 calls on this fixture (pre + post-status per
      // store). When it finishes, queue the cancellation for the next
      // macrotask — the recovery loop's first inter-store yield — so the
      // post-yield recheck sees it and store 1's recoverStore never runs
      // (#149935 Rev 2/4). Without that guard the store is loaded first and
      // this test fails.
      let cancelled = false;
      const result = await recoverRestartAbortedMainSessions({
        cfg,
        stateDir: tmpDir,
        gatewayRuntime: {
          dispatchSessionMethod: vi.fn(),
          dispatchAgent: vi.fn(),
          waitForAgent: vi.fn(),
          sendRecoveryNotice: vi.fn(),
        } as unknown as Parameters<typeof recoverRestartAbortedMainSessions>[0]["gatewayRuntime"],
        shouldContinue: () => {
          const call = ++shouldContinueCalls;
          if (call === 9) {
            setImmediate(() => {
              cancelled = true;
            });
          }
          return !cancelled;
        },
      });

      expect(cancelled).toBe(true);
      expect(callsAtFirstRecoverStore).toBe(-1);
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

      // Internal callers may hit the status probe more than once per store;
      // the pin is that store B is never probed at all.
      const probedStoreB = probeSpy.mock.calls.filter(([target]) =>
        String(target?.storePath ?? "").includes("dstop-b"),
      );
      expect(probedStoreB).toHaveLength(0);
      expect(storeTargets).toHaveLength(0);
      probeSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
