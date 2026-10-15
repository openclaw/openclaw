/** Tests resume identity persistence before native terminal signals and cleanup. */
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { isAcpTurnActive } from "./active-turns.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  expectRejectedRecord,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager one-shot resume completion", () => {
  installAcpSessionManagerTestLifecycle();

  it("retains active-turn custody until completed one-shot cleanup settles", async () => {
    await withStateDirEnv("openclaw-acp-resume-", async () => {
      const runtimeState = createRuntime();
      const closeStarted = createDeferred();
      const releaseClose = createDeferred();
      runtimeState.close.mockImplementation(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const childSessionKey = "agent:claude:acp:child-terminal-cleanup";
      const parentSessionKey = "agent:main:cron:job-terminal-cleanup";
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === childSessionKey) {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-terminal-cleanup",
              updatedAt: Date.now(),
              spawnedBy: parentSessionKey,
            },
            acp: readySessionMeta({ mode: "oneshot" }),
          };
        }
        if (sessionKey === parentSessionKey) {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: { sessionId: "parent-terminal-cleanup", updatedAt: Date.now() },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      const turn = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "complete before cleanup",
        mode: "prompt",
        requestId: "terminal-cleanup-acp-turn",
      });

      await Promise.race([closeStarted.promise, turn]);
      try {
        expect(
          (await listSessionStateEventsSince(childSessionKey, "claude", 0, 200)).events,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "run_completed", runId: "terminal-cleanup-acp-turn" }),
          ]),
        );
        expect(runtimeState.close).toHaveBeenCalledTimes(1);
        expect(isAcpTurnActive({ sessionKey: childSessionKey, agentId: "claude" })).toBe(true);
      } finally {
        releaseClose.resolve();
        await turn;
      }
      expect(isAcpTurnActive({ sessionKey: childSessionKey, agentId: "claude" })).toBe(false);
    });
  });

  it("reconciles post-turn resume identity before publishing a terminal signal", async () => {
    await withStateDirEnv("openclaw-acp-resume-", async () => {
      const runtimeState = createRuntime();
      const postTurnStatusStarted = createDeferred();
      const releasePostTurnStatus = createDeferred();
      let turnFinished = false;
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        sessionResumeSupported: true,
      }));
      runtimeState.runTurn.mockImplementation(async function* () {
        turnFinished = true;
        yield { type: "done" as const };
      });
      runtimeState.getStatus.mockImplementation(async () => {
        if (!turnFinished) {
          return { summary: "status=alive", details: { status: "alive" } };
        }
        postTurnStatusStarted.resolve();
        await releasePostTurnStatus.promise;
        return {
          summary: "status=alive",
          details: { status: "alive" },
          backendSessionId: "acpx-session-after-turn",
        };
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const childSessionKey = "agent:claude:acp:child-post-turn-resume-id";
      const parentSessionKey = "agent:main:cron:job-post-turn-resume-id";
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === childSessionKey) {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-post-turn-resume-id",
              updatedAt: Date.now(),
              spawnedBy: parentSessionKey,
            },
            acp: readySessionMeta({ mode: "oneshot" }),
          };
        }
        if (sessionKey === parentSessionKey) {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: { sessionId: "parent-post-turn-resume-id", updatedAt: Date.now() },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      const turn = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "publish the resume id after completion",
        mode: "prompt",
        requestId: "post-turn-resume-id-acp-turn",
      });

      await Promise.race([postTurnStatusStarted.promise, turn]);
      try {
        expect(
          (await listSessionStateEventsSince(childSessionKey, "claude", 0, 200)).events,
        ).toHaveLength(0);
        expect(isAcpTurnActive({ sessionKey: childSessionKey, agentId: "claude" })).toBe(true);
      } finally {
        releasePostTurnStatus.resolve();
        await turn;
      }

      expect((await listSessionStateEventsSince(childSessionKey, "claude", 0, 200)).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "run_completed", runId: "post-turn-resume-id-acp-turn" }),
        ]),
      );
      expect(isAcpTurnActive({ sessionKey: childSessionKey, agentId: "claude" })).toBe(false);
      expectRecordFields(mockCallArg(runtimeState.close), {
        handle: expect.objectContaining({ backendSessionId: "acpx-session-after-turn" }),
      });
    });
  });

  it("fails a completed one-shot without replaying it when resume identity persistence fails", async () => {
    await withStateDirEnv("openclaw-acp-resume-", async () => {
      const runtimeState = createRuntime();
      let turnFinished = false;
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        sessionResumeSupported: true,
      }));
      runtimeState.runTurn.mockImplementation(async function* () {
        turnFinished = true;
        yield { type: "done" as const };
      });
      runtimeState.getStatus.mockImplementation(async () => ({
        summary: "status=alive",
        details: { status: "alive" },
        ...(turnFinished ? { backendSessionId: "acpx-session-write-failure" } : {}),
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const childSessionKey = "agent:claude:acp:child-resume-write-failure";
      const parentSessionKey = "agent:main:cron:job-resume-write-failure";
      const storedMeta = readySessionMeta({
        mode: "oneshot",
        identity: {
          state: "pending",
          source: "ensure",
          sessionResumeSupported: true,
          lastUpdatedAt: Date.now(),
        },
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === childSessionKey) {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-resume-write-failure",
              updatedAt: Date.now(),
              spawnedBy: parentSessionKey,
            },
            acp: storedMeta,
          };
        }
        if (sessionKey === parentSessionKey) {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: { sessionId: "parent-resume-write-failure", updatedAt: Date.now() },
          };
        }
        return null;
      });
      hoisted.upsertAcpSessionMetaMock.mockImplementation(
        async (paramsUnknown: {
          mutate: (
            current: SessionAcpMeta | undefined,
            entry: { acp?: SessionAcpMeta } | undefined,
          ) => SessionAcpMeta | null | undefined;
        }) => {
          const next = paramsUnknown.mutate(storedMeta, { acp: storedMeta });
          if (next?.identity?.acpxSessionId === "acpx-session-write-failure") {
            throw new Error("resume identity write failed");
          }
          return null;
        },
      );

      const manager = new AcpSessionManager();
      await expectRejectedRecord(
        manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey: childSessionKey,
          text: "do not replay this completed turn",
          mode: "prompt",
          requestId: "resume-write-failure-acp-turn",
        }),
        {
          code: "ACP_TURN_FAILED",
          message: "resume identity write failed",
        },
      );

      expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
      expect((await listSessionStateEventsSince(childSessionKey, "claude", 0, 200)).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "run_failed", runId: "resume-write-failure-acp-turn" }),
        ]),
      );
      expect(isAcpTurnActive({ sessionKey: childSessionKey, agentId: "claude" })).toBe(false);
    });
  });

  it("keeps a completed persistent turn successful when identity persistence fails", async () => {
    await withStateDirEnv("openclaw-acp-resume-", async () => {
      const runtimeState = createRuntime();
      let turnFinished = false;
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
      }));
      runtimeState.runTurn.mockImplementation(async function* () {
        turnFinished = true;
        yield { type: "done" as const };
      });
      runtimeState.getStatus.mockImplementation(async () => ({
        summary: "status=alive",
        details: { status: "alive" },
        ...(turnFinished ? { backendSessionId: "persistent-session-write-failure" } : {}),
      }));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const childSessionKey = "agent:claude:acp:persistent-write-failure";
      const parentSessionKey = "agent:main:cron:persistent-write-failure";
      const storedMeta = readySessionMeta({ mode: "persistent" });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === childSessionKey) {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "persistent-write-failure",
              updatedAt: Date.now(),
              spawnedBy: parentSessionKey,
            },
            acp: storedMeta,
          };
        }
        if (sessionKey === parentSessionKey) {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: { sessionId: "persistent-write-failure-parent", updatedAt: Date.now() },
          };
        }
        return null;
      });
      hoisted.upsertAcpSessionMetaMock.mockImplementation(
        async (paramsUnknown: {
          mutate: (
            current: SessionAcpMeta | undefined,
            entry: { acp?: SessionAcpMeta } | undefined,
          ) => SessionAcpMeta | null | undefined;
        }) => {
          const next = paramsUnknown.mutate(storedMeta, { acp: storedMeta });
          if (next?.identity?.acpxSessionId === "persistent-session-write-failure") {
            throw new Error("persistent identity write failed");
          }
          return null;
        },
      );

      const manager = new AcpSessionManager();
      await expect(
        manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey: childSessionKey,
          text: "complete despite best-effort identity persistence",
          mode: "prompt",
          requestId: "persistent-write-failure-acp-turn",
        }),
      ).resolves.toBeUndefined();

      expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
      expect((await listSessionStateEventsSince(childSessionKey, "claude", 0, 200)).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "run_completed",
            runId: "persistent-write-failure-acp-turn",
          }),
        ]),
      );
      expect(isAcpTurnActive({ sessionKey: childSessionKey, agentId: "claude" })).toBe(false);
    });
  });
});
