/** Tests completed ACP one-shot resume, capability, and fail-closed behavior. */
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";
import type { AcpSessionManagerDeps } from "./manager.types.js";

describe("AcpSessionManager one-shot resume handles", () => {
  installAcpSessionManagerTestLifecycle();

  it("does not resume one-shot identity without confirmed agent support", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:binding:demo-binding:default:oneshot-unconfirmed",
      backend: "acpx",
      runtimeSessionName: "fresh-oneshot-runtime",
      acpxRecordId: "fresh-record",
      backendSessionId: "fresh-acpx-session",
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:oneshot-unconfirmed";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: key,
          mode: "oneshot",
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-unconfirmed",
            agentSessionId: "agent-sid-unconfirmed",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "safe fresh retry",
      mode: "prompt",
      requestId: "r-binding-oneshot-unconfirmed",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(mockCallArg(runtimeState.ensureSession).resumeSessionId).toBeUndefined();
    const turnHandle = mockCallArg(runtimeState.runTurn).handle as AcpRuntimeHandle;
    expectRecordFields(turnHandle, {
      backendSessionId: "fresh-acpx-session",
    });
    expect(turnHandle.agentSessionId).toBeUndefined();
  });

  it.each(
    ["ensure", "reconnect"].flatMap((phase) =>
      ["missing", "ambiguous", "unrelated", "transient", "timeout", "auth", "owner-repair"].map(
        (kind) => ({ phase, kind }),
      ),
    ),
  )(
    "handles a persisted one-shot resume failure without losing valid context ($phase, $kind)",
    async ({ phase, kind }) => {
      const runtimeState = createRuntime();
      const missing = kind === "missing";
      const failure = new AcpRuntimeError(
        phase === "ensure" ? "ACP_SESSION_INIT_FAILED" : "ACP_TURN_FAILED",
        kind === "ambiguous"
          ? "Session not found"
          : kind === "unrelated"
            ? "Resource not found: workspace file"
            : kind === "transient"
              ? "connection reset while resuming session"
              : kind === "timeout"
                ? "session/load timed out"
                : kind === "auth"
                  ? "authentication required"
                  : "failed to resume one-shot ACP session",
        {
          detailCode: missing
            ? "SESSION_RESUME_TARGET_NOT_FOUND"
            : kind === "owner-repair"
              ? "SESSION_OWNER_MIGRATION_REQUIRED"
              : "SESSION_RESUME_REQUIRED",
        },
      );
      const startTurn = vi.fn<NonNullable<AcpRuntime["startTurn"]>>((input) => ({
        requestId: input.requestId,
        events: (async function* () {})(),
        result: Promise.resolve({ status: "failed", error: failure }),
        cancel: async () => {},
        closeStream: async () => {},
      }));
      runtimeState.runtime.startTurn = startTurn;
      if (phase === "ensure") {
        runtimeState.ensureSession.mockRejectedValue(failure);
      }
      // A stale status observation must not restore identity after a missing-target failure.
      runtimeState.getStatus.mockResolvedValue({
        agentSessionId: "agent-session-stale",
        backendSessionId: "backend-session-stale",
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const sessionKey = "agent:claude:acp:binding:demo-binding:default:oneshot-stale";
      let currentMeta: SessionAcpMeta = {
        ...readySessionMeta(),
        runtimeSessionName: sessionKey,
        mode: "oneshot",
        identity: {
          state: "resolved",
          source: "status",
          agentSessionId: "agent-session-stale",
          sessionResumeSupported: true,
          sessionResumeReady: true,
          lastUpdatedAt: Date.now(),
        },
      };
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
        return {
          sessionKey: key,
          storeSessionKey: key,
          entry: { sessionId: "session-oneshot-stale", updatedAt: Date.now(), acp: currentMeta },
          acp: currentMeta,
        };
      });
      hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
        const params = paramsUnknown as {
          assertCommitAllowed?: () => void;
          mutate: (
            current: SessionAcpMeta | undefined,
            entry: { acp?: SessionAcpMeta } | undefined,
          ) => SessionAcpMeta | null | undefined;
        };
        const next = params.mutate(currentMeta, { acp: currentMeta });
        params.assertCommitAllowed?.();
        if (!next) {
          return null;
        }
        currentMeta = next;
        return { sessionId: "session-oneshot-stale", updatedAt: Date.now(), acp: currentMeta };
      });

      const manager = new AcpSessionManager();
      await expect(
        manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey,
          text: "follow-up after restart",
          mode: "prompt",
          requestId: "r-binding-oneshot-stale",
        }),
      ).rejects.toMatchObject({
        code: failure.code,
        message: failure.message,
      });

      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(runtimeState.ensureSession), {
        sessionKey,
        agentId: "claude",
        mode: "oneshot",
        resumeSessionId: "agent-session-stale",
      });
      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(startTurn).toHaveBeenCalledTimes(phase === "ensure" ? 0 : 1);
      expect(runtimeState.prepareFreshSession).not.toHaveBeenCalled();
      if (missing) {
        expect(currentMeta.identity?.acpxSessionId).toBeUndefined();
        expect(currentMeta.identity?.agentSessionId).toBeUndefined();
        expect(currentMeta.identity?.sessionResumeSupported).toBeUndefined();
        expect(currentMeta.identity?.sessionResumeReady).toBeUndefined();
        expect(runtimeState.getStatus).not.toHaveBeenCalled();
      } else {
        expect(currentMeta.identity).toMatchObject({
          agentSessionId: "agent-session-stale",
          sessionResumeSupported: true,
          sessionResumeReady: true,
        });
      }
      expect(currentMeta.backend).toBe("acpx");
      expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
    },
  );

  it("resumes completed one-shot sessions after the runtime handle cache is gone", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession
      .mockResolvedValueOnce({
        sessionKey: "agent:claude:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "agent:claude:acp:session-1:oneshot:runtime",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
        sessionResumeSupported: true,
      })
      .mockResolvedValueOnce({
        sessionKey: "agent:claude:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "agent:claude:acp:session-1:oneshot:runtime",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:session-1";
    let currentMeta: SessionAcpMeta | undefined;
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      agentId: "claude",
      entry: sessionEntry,
      ...(currentMeta ? { acp: currentMeta } : {}),
    }));
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        assertCommitAllowed?: () => void;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta; sessionId: string; updatedAt: number } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const entry = currentMeta ? { ...sessionEntry, acp: currentMeta } : sessionEntry;
      const next = params.mutate(currentMeta, entry);
      params.assertCommitAllowed?.();
      if (next === null) {
        currentMeta = undefined;
        return { ...sessionEntry };
      }
      if (next !== undefined) {
        currentMeta = next;
      }
      return {
        ...sessionEntry,
        ...(currentMeta ? { acp: currentMeta } : {}),
      };
    });

    const managerA = new AcpSessionManager();
    await managerA.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "claude",
      mode: "oneshot",
    });
    expect(currentMeta?.identity?.sessionResumeSupported).toBe(true);
    await managerA.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "initial one-shot",
      mode: "prompt",
      requestId: "r-oneshot-initial",
      provenance: "system",
    });
    expect(currentMeta?.identity?.sessionResumeSupported).toBe(true);
    expect(currentMeta?.identity?.sessionResumeReady).toBe(true);
    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "follow-up",
      mode: "prompt",
      requestId: "r-oneshot-follow-up",
      provenance: "system",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.ensureSession, 1), {
      sessionKey,
      agentId: "claude",
      agent: "claude",
      mode: "oneshot",
      resumeSessionId: "acpx-session-1",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
    expect(mockCallArg(runtimeState.runTurn, 1).handle).toMatchObject({
      sessionKey,
      agentId: "claude",
      backendSessionId: "acpx-session-1",
      agentSessionId: "agent-session-1",
    });
    for (const [input] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
      expect(input).toMatchObject({ sessionKey, agentId: "claude" });
    }
  });

  it("does not mark a pre-prompt cancelled one-shot ready to resume", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:cancelled-before-prompt",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:cancelled-before-prompt:oneshot:runtime",
      acpxRecordId: "record-cancelled-before-prompt",
      backendSessionId: "codex-unmaterialized-thread",
      sessionResumeSupported: true,
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done", stopReason: "cancelled" };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:cancelled-before-prompt";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: sessionKey,
      mode: "oneshot",
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      sessionId: "session-cancelled-before-prompt",
      updatedAt: Date.now(),
      acp: currentMeta,
    }));
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        assertCommitAllowed?: () => void;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      params.assertCommitAllowed?.();
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-cancelled-before-prompt",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "never submitted",
      mode: "prompt",
      requestId: "r-cancelled-before-prompt",
      provenance: "system",
    });

    expect(currentMeta.identity).toMatchObject({
      acpxSessionId: "codex-unmaterialized-thread",
      sessionResumeSupported: true,
    });
    expect(currentMeta.identity?.sessionResumeReady).toBeUndefined();
  });

  it("preserves one-shot resume support until status resolves the session id", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession
      .mockResolvedValueOnce({
        sessionKey: "agent:claude:acp:session-capability-first",
        backend: "acpx",
        runtimeSessionName: "agent:claude:acp:session-capability-first:oneshot:runtime",
        sessionResumeSupported: true,
      })
      .mockResolvedValueOnce({
        sessionKey: "agent:claude:acp:session-capability-first",
        backend: "acpx",
        runtimeSessionName: "agent:claude:acp:session-capability-first:oneshot:runtime",
        backendSessionId: "acpx-session-capability-first",
      });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-session-capability-first",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:session-capability-first";
    let currentMeta: SessionAcpMeta | undefined;
    const sessionEntry = {
      sessionId: "session-capability-first",
      updatedAt: Date.now(),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      agentId: "claude",
      entry: sessionEntry,
      ...(currentMeta ? { acp: currentMeta } : {}),
    }));
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        assertCommitAllowed?: () => void;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta; sessionId: string; updatedAt: number } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const entry = currentMeta ? { ...sessionEntry, acp: currentMeta } : sessionEntry;
      const next = params.mutate(currentMeta, entry);
      params.assertCommitAllowed?.();
      if (next === null) {
        currentMeta = undefined;
        return { ...sessionEntry };
      }
      if (next !== undefined) {
        currentMeta = next;
      }
      return {
        ...sessionEntry,
        ...(currentMeta ? { acp: currentMeta } : {}),
      };
    });

    const managerA = new AcpSessionManager();
    await managerA.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "claude",
      mode: "oneshot",
    });
    await managerA.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "initial one-shot",
      mode: "prompt",
      requestId: "r-capability-first-initial",
      provenance: "system",
    });

    expect(currentMeta?.identity).toMatchObject({
      acpxSessionId: "acpx-session-capability-first",
      sessionResumeSupported: true,
    });

    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "follow-up",
      mode: "prompt",
      requestId: "r-capability-first-follow-up",
      provenance: "system",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession, 1), {
      agentId: "claude",
      mode: "oneshot",
      resumeSessionId: "acpx-session-capability-first",
    });
  });

  it.each(["ensure", "reconnect"])(
    "does not clear the successor identity when an old one-shot resume fails after reset (%s)",
    async (phase) => {
      const runtimeState = createRuntime();
      const resumeEntered = createDeferred();
      const releaseResume = createDeferred();
      const sessionKey = "agent:claude:acp:oneshot-resume-reset";
      const target = { cfg: baseCfg, sessionKey, agentId: "claude" };
      let currentMeta: SessionAcpMeta | undefined = {
        ...readySessionMeta(),
        agent: "claude",
        runtimeSessionName: "completed-runtime",
        mode: "oneshot",
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "completed-session",
          sessionResumeSupported: true,
          sessionResumeReady: true,
          lastUpdatedAt: 1,
        },
      };
      const sessionEntry = { sessionId: "oneshot-resume-reset", updatedAt: 1 };
      hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
        sessionKey,
        storeSessionKey: sessionKey,
        agentId: target.agentId,
        entry: sessionEntry,
        acp: currentMeta,
      }));
      hoisted.upsertAcpSessionMetaMock.mockImplementation(
        async (input: Parameters<AcpSessionManagerDeps["upsertSessionMeta"]>[0]) => {
          const next = input.mutate(currentMeta, sessionEntry);
          input.assertCommitAllowed?.();
          if (next !== undefined) {
            currentMeta = next ?? undefined;
          }
          return { ...sessionEntry, acp: currentMeta };
        },
      );
      const failResume = async () => {
        resumeEntered.resolve();
        await releaseResume.promise;
        throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "old resume target disappeared", {
          detailCode: "SESSION_RESUME_TARGET_NOT_FOUND",
        });
      };
      const startTurn = vi.fn<NonNullable<AcpRuntime["startTurn"]>>((input) => ({
        requestId: input.requestId,
        events: (async function* () {})(),
        result: failResume(),
        cancel: async () => {},
        closeStream: async () => {},
      }));
      runtimeState.runtime.startTurn = startTurn;
      if (phase === "ensure") {
        runtimeState.ensureSession.mockImplementationOnce(failResume);
      } else {
        runtimeState.ensureSession.mockResolvedValueOnce({
          sessionKey,
          agentId: target.agentId,
          backend: "acpx",
          runtimeSessionName: "completed-runtime",
          backendSessionId: "completed-session",
          sessionResumeSupported: true,
        });
      }
      runtimeState.ensureSession.mockResolvedValueOnce({
        sessionKey,
        agentId: target.agentId,
        backend: "acpx",
        runtimeSessionName: "successor-runtime",
        backendSessionId: "successor-session",
        sessionResumeSupported: true,
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const manager = new AcpSessionManager();
      const staleTurn = manager.runTurn({
        ...target,
        text: "resume completed work",
        mode: "prompt",
        requestId: "stale-oneshot-resume",
        provenance: "system",
      });
      const staleResult = staleTurn.catch((error: unknown) => error);
      try {
        await resumeEntered.promise;
        await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
          ...target,
          reason: "session-reset",
        });
        await manager.initializeSession({ ...target, agent: "claude", mode: "oneshot" });
        const successorMeta = currentMeta;
        const writesBeforeFailure = hoisted.upsertAcpSessionMetaMock.mock.calls.length;

        releaseResume.resolve();
        expect(await staleResult).toMatchObject({ detailCode: "SESSION_ACTOR_SUPERSEDED" });
        expect(currentMeta).toEqual(successorMeta);
        expect(currentMeta?.identity?.acpxSessionId).toBe("successor-session");
        expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(writesBeforeFailure);
        expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
        expect(mockCallArg(runtimeState.ensureSession)).toMatchObject({
          sessionKey,
          agentId: "claude",
          resumeSessionId: "completed-session",
        });
        expect(runtimeState.runTurn).not.toHaveBeenCalled();
        expect(startTurn).toHaveBeenCalledTimes(phase === "ensure" ? 0 : 1);
        expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(1);
      } finally {
        releaseResume.resolve();
        await staleResult;
      }
    },
  );
});
