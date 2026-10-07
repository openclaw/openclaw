import type { AcpRuntimeEvent, AcpRuntimeTurnInput } from "@openclaw/acp-core/runtime/types";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { listActiveAcpSessionsForOwner } from "./active-turns.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  expectRejectedRecord,
  extractStateUpsertPersistenceOptions,
  extractStatesFromUpserts,
  flushMicrotasks,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  mockParentedAcpSessionEntries,
  readySessionMeta,
  resetAcpSessionManagerForTests,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager", () => {
  installAcpSessionManagerTestLifecycle();
  const target = { cfg: baseCfg, sessionKey: "agent:codex:acp:session-1" };
  const turnInput = { ...target, provenance: "system" as const, mode: "prompt" as const };
  const resetOptions = {
    reason: "new-in-place-reset",
    allowBackendUnavailable: true,
    discardPersistentState: true,
  };
  const ownerSessionKey = "agent:quant:telegram:quant:direct:822430204";
  const childSessionKey = "agent:codex:acp:child-1";
  const bindingSessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";

  function sessionEntry(meta = readySessionMeta(), sessionKey = target.sessionKey) {
    return { sessionKey, storeSessionKey: sessionKey, acp: meta };
  }

  function fixture(meta = readySessionMeta(), sessionKey = target.sessionKey) {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue(sessionEntry(meta, sessionKey));
    const manager = new AcpSessionManager();
    const run = (
      text: string,
      requestId: string,
      overrides: Partial<Parameters<AcpSessionManager["runTurn"]>[0]> = {},
    ) => manager.runTurn({ ...turnInput, sessionKey, text, requestId, ...overrides });
    const close = (
      options: Omit<Parameters<AcpSessionManager["closeSession"]>[0], "cfg" | "sessionKey">,
    ) => manager.closeSession({ cfg: baseCfg, sessionKey, ...options });
    return { runtimeState, manager, run, close };
  }

  function installMutableEntry(entry: ReturnType<typeof sessionEntry>) {
    hoisted.readAcpSessionEntryMock.mockImplementation(() => entry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async (params: {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      }) => {
        const next = params.mutate(entry.acp, entry);
        if (next === null) {
          return null;
        }
        if (next) {
          entry.acp = next;
        }
        return entry;
      },
    );
  }

  function failBackendLookup(
    code: "ACP_BACKEND_MISSING" | "ACP_BACKEND_UNAVAILABLE",
    message: string,
  ) {
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(code, message);
    });
  }

  it("marks ACP-shaped sessions without metadata as stale", () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue(null);
    const resolved = new AcpSessionManager().resolveSession(target);
    expect(resolved.kind).toBe("stale");
    if (resolved.kind !== "stale") {
      return;
    }
    expect(resolved.error.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(resolved.error.message).toContain("ACP metadata is missing");
    expectRecordFields(mockCallArg(hoisted.readAcpSessionEntryMock), {
      clone: false,
      sessionKey: target.sessionKey,
    });
  });

  it("canonicalizes the main alias before ACP rehydrate after restart", async () => {
    const f = fixture();
    hoisted.readAcpSessionEntryMock.mockImplementation(({ sessionKey }: { sessionKey?: string }) =>
      sessionKey === "agent:main:main"
        ? sessionEntry(
            readySessionMeta({ agent: "main", runtimeSessionName: sessionKey }),
            sessionKey,
          )
        : null,
    );
    const cfg = {
      ...baseCfg,
      session: { mainKey: "main" },
      agents: { entries: { main: {} } },
    } satisfies OpenClawConfig;
    await f.run("after restart", "r-main", { cfg, sessionKey: "main" });
    expectRecordFields(mockCallArg(hoisted.readAcpSessionEntryMock), {
      cfg,
      sessionKey: "agent:main:main",
    });
    expectRecordFields(mockCallArg(f.runtimeState.ensureSession), {
      agent: "main",
      sessionKey: "agent:main:main",
    });
    expect(extractStateUpsertPersistenceOptions()).toEqual([
      { state: "running", skipMaintenance: true, takeCacheOwnership: true },
      { state: "idle", skipMaintenance: true, takeCacheOwnership: true },
    ]);
  });

  it("marks liveness during runtime initialization, before the turn streams (#88205)", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const f = fixture();
      const releaseInit = createDeferred();
      const streamEntered = createDeferred();
      const releaseStream = createDeferred();
      f.runtimeState.runTurn.mockImplementation(async function* () {
        streamEntered.resolve();
        await releaseStream.promise;
        yield { type: "done" };
      });
      f.runtimeState.ensureSession.mockImplementation(async (input) => {
        await releaseInit.promise;
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        };
      });
      mockParentedAcpSessionEntries({
        childSessionKey,
        parentSessionKey: ownerSessionKey,
        label: "Init window",
      });
      const turn = f.run("slow init", "init-window-acp-turn", { sessionKey: childSessionKey });
      await vi.waitFor(
        () => {
          expect(f.runtimeState.ensureSession).toHaveBeenCalled();
        },
        { interval: 1 },
      );
      expect(f.runtimeState.runTurn).not.toHaveBeenCalled();
      expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([childSessionKey]);
      releaseInit.resolve();
      await streamEntered.promise;
      expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([childSessionKey]);
      releaseStream.resolve();
      await turn;
      await flushMicrotasks();
      expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([]);
    });
  }, 300_000);

  it("clears liveness when retry setup throws before terminal publication (#88205)", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const f = fixture();
      let initialTurnFailed = false;
      f.runtimeState.runTurn.mockImplementationOnce(async function* () {
        expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([childSessionKey]);
        initialTurnFailed = true;
        yield { type: "error", message: "acpx exited with code 1" };
      });
      hoisted.readAcpSessionEntryMock.mockImplementation(
        ({ sessionKey }: { sessionKey?: string }) => {
          if (sessionKey === childSessionKey) {
            if (initialTurnFailed) {
              throw new Error("session store unavailable");
            }
            return {
              ...sessionEntry(readySessionMeta(), sessionKey),
              entry: {
                sessionId: "child-1",
                updatedAt: Date.now(),
                spawnedBy: ownerSessionKey,
                label: "Retry cleanup",
              },
            };
          }
          if (sessionKey === ownerSessionKey) {
            return {
              sessionKey,
              storeSessionKey: sessionKey,
              entry: { sessionId: "parent-1", updatedAt: Date.now() },
            };
          }
          return null;
        },
      );
      await expect(
        f.run("stale resume", "retry-cleanup-failure-acp-turn", { sessionKey: childSessionKey }),
      ).rejects.toThrow("session store unavailable");
      expect(f.runtimeState.runTurn).toHaveBeenCalledOnce();
      expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([]);
    });
  }, 300_000);

  it("cancels a queued turn promptly when its caller aborts before the actor is free", async () => {
    const f = fixture();
    const firstTurnStarted = createDeferred();
    const releaseFirstTurn = createDeferred();
    f.runtimeState.runTurn.mockImplementation(async function* ({ requestId }) {
      if (requestId === "r1") {
        firstTurnStarted.resolve();
        await releaseFirstTurn.promise;
      }
      yield { type: "done" };
    });
    const first = f.run("first", "r1");
    const abortController = new AbortController();
    const events: AcpRuntimeEvent[] = [];
    let second: Promise<void> | undefined;
    try {
      await Promise.race([firstTurnStarted.promise, first]);
      second = f.run("second", "r2", {
        admittedRunContext: createTestAdmittedRunContext("r2"),
        signal: abortController.signal,
        onEvent: (event) => {
          events.push(event);
        },
      });
      expect(f.manager.getObservabilitySnapshot().turns.queueDepth).toBe(2);
      abortController.abort();
      await second;
      expect(f.manager.getObservabilitySnapshot().turns.queueDepth).toBe(2);
      expect(events).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
      expect(f.runtimeState.runTurn).toHaveBeenCalledOnce();
      releaseFirstTurn.resolve();
      await first;
      await f.manager.getSessionStatus(target);
      expect(f.manager.getObservabilitySnapshot().turns.queueDepth).toBe(0);
    } finally {
      abortController.abort();
      releaseFirstTurn.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("forwards the exact elicitation closure with the manager-composed turn signal", async () => {
    const f = fixture();
    let captured: AcpRuntimeTurnInput | undefined;
    f.runtimeState.runTurn.mockImplementationOnce(async function* (input) {
      captured = input;
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", status: "cancelled" };
    });
    const onElicitation = vi.fn(async () => ({ action: "cancel" as const }));
    const caller = new AbortController();
    const turn = f.run("ask", "r-elicitation", { signal: caller.signal, onElicitation });
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(captured?.onElicitation).toBe(onElicitation);
    expect(captured?.signal).not.toBe(caller.signal);
    expect(captured?.signal?.aborted).toBe(false);
    caller.abort();
    await turn;
    expect(captured?.signal?.aborted).toBe(true);
  });

  it("times out a hung persistent turn after partial progress without closing the session and lets queued work continue", async () => {
    vi.useFakeTimers();
    try {
      await withStateDirEnv("openclaw-acp-manager-", async () => {
        const f = fixture();
        mockParentedAcpSessionEntries({
          childSessionKey: target.sessionKey,
          parentSessionKey: "agent:main:main",
        });
        let firstTurnStarted = false;
        f.runtimeState.runTurn.mockImplementation(async function* ({ requestId }) {
          if (requestId === "r1") {
            firstTurnStarted = true;
            yield { type: "text_delta", text: "Working on it..." };
            await new Promise(() => {});
          }
          yield { type: "done" };
        });
        const cfg = {
          ...baseCfg,
          agents: { defaults: { timeoutSeconds: 1 } },
        } satisfies OpenClawConfig;
        const first = f.run("first", "r1", { cfg });
        void first.catch(() => undefined);
        await vi.waitFor(
          () => {
            expect(firstTurnStarted).toBe(true);
          },
          { interval: 1 },
        );
        const second = f.run("second", "r2", { cfg });
        await flushMicrotasks();
        expect(f.runtimeState.runTurn).toHaveBeenCalledOnce();
        expect(f.manager.getObservabilitySnapshot().turns.queueDepth).toBe(2);
        await vi.advanceTimersByTimeAsync(3_500);
        await expectRejectedRecord(first, {
          code: "ACP_TURN_FAILED",
          message: "ACP turn timed out after 1s.",
        });
        await expect(second).resolves.toBeUndefined();
        expect(f.runtimeState.ensureSession).toHaveBeenCalledTimes(1);
        expect(f.runtimeState.runTurn).toHaveBeenCalledTimes(2);
        expectRecordFields(mockCallArg(f.runtimeState.cancel), { reason: "turn-timeout" });
        expect(f.runtimeState.close).not.toHaveBeenCalled();
        const snapshot = f.manager.getObservabilitySnapshot();
        expect(snapshot.runtimeCache.activeSessions).toBe(1);
        expect(snapshot.errorsByCode.ACP_TURN_FAILED).toBe(1);
        expectRecordFields(snapshot.turns, { active: 0, queueDepth: 0, completed: 1, failed: 1 });
        const states = extractStatesFromUpserts();
        expect(states).toContain("error");
        expect(states.at(-1)).toBe("idle");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps ACP runtime option turn timeouts before arming the watchdog", async () => {
    const f = fixture(
      readySessionMeta({ runtimeOptions: { timeoutSeconds: Number.MAX_SAFE_INTEGER } }),
    );
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await f.run("first", "r1");
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("uses metadata backend when global acp.backend is unset", async () => {
    const f = fixture(
      readySessionMeta({ backend: "metadata-backend", runtimeSessionName: "metadata-runtime" }),
    );
    f.runtimeState.ensureSession.mockImplementation(async ({ sessionKey }) => ({
      sessionKey,
      backend: "metadata-backend",
      runtimeSessionName: "metadata-runtime",
    }));
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId !== "metadata-backend") {
        throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
      }
      return { id: "metadata-backend", runtime: f.runtimeState.runtime };
    });
    const cfg = { acp: { enabled: true, dispatch: { enabled: true } } } satisfies OpenClawConfig;
    await expect(f.run("hello", "r-metadata", { cfg })).resolves.toBeUndefined();
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("metadata-backend");
    expect(f.runtimeState.runTurn).toHaveBeenCalledTimes(1);
  });

  it("tolerates backend and stale-process failures during close", async () => {
    for (const testCase of [
      {
        label: "backend unavailable",
        error: new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "runtime temporarily unavailable"),
        notice: "temporarily unavailable",
      },
      {
        label: "stale acpx process exit",
        error: new Error("acpx exited with code 1"),
        notice: "acpx exited with code 1",
      },
    ]) {
      resetAcpSessionManagerForTests();
      const f = fixture();
      f.runtimeState.close.mockRejectedValueOnce(testCase.error);
      hoisted.readAcpSessionEntryMock.mockImplementation(
        ({ sessionKey = "" }: { sessionKey?: string }) =>
          sessionEntry(
            readySessionMeta({ runtimeSessionName: `runtime:${sessionKey}` }),
            sessionKey,
          ),
      );
      const sessionKey = "agent:codex:acp:session-a";
      await f.run("first", "r1", { sessionKey });
      const result = await f.manager.closeSession({
        cfg: baseCfg,
        sessionKey,
        reason: "manual-close",
        allowBackendUnavailable: true,
      });
      expect(result.runtimeClosed, testCase.label).toBe(false);
      expect(result.runtimeNotice, testCase.label).toContain(testCase.notice);
      await expect(
        f.run("second", "r2", { sessionKey: "agent:codex:acp:session-b" }),
        testCase.label,
      ).resolves.toBeUndefined();
      expect(f.runtimeState.ensureSession, testCase.label).toHaveBeenCalledTimes(2);
    }
  });

  it("treats stale session init failures as recoverable during discard resets", async () => {
    const sessionKey = "agent:claude:acp:session-1";
    const f = fixture(readySessionMeta({ agent: "claude" }), sessionKey);
    f.runtimeState.ensureSession.mockRejectedValueOnce(
      new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Could not initialize ACP session runtime."),
    );
    const result = await f.close(resetOptions);
    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toBe("Could not initialize ACP session runtime.");
    expect(f.runtimeState.prepareFreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, agentId: "claude" }),
    );
  });

  it("treats unsupported close controls as recoverable during discard cleanup", async () => {
    const sessionKey = "agent:openclaw:acp:session-1";
    const f = fixture(readySessionMeta({ agent: "openclaw" }), sessionKey);
    f.runtimeState.close.mockRejectedValueOnce(
      new AcpRuntimeError(
        "ACP_BACKEND_UNSUPPORTED_CONTROL",
        'ACP backend "acpx" does not support session/close.',
      ),
    );
    const result = await f.close({
      ...resetOptions,
      reason: "terminal-task-cleanup",
      clearMeta: true,
    });
    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("does not support session/close");
    expect(result.metaCleared).toBe(true);
    expect(f.runtimeState.prepareFreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, agentId: "openclaw" }),
    );
  });

  it("discards resume identity and prepares a fresh runtime for the next turn", async () => {
    const sessionKey = bindingSessionKey;
    const entry = sessionEntry(
      readySessionMeta({
        agent: "claude",
        state: "running",
        lastError: "stale failure",
        identity: {
          state: "resolved",
          acpxRecordId: sessionKey,
          acpxSessionId: "acpx-session-1",
          agentSessionId: "agent-session-1",
          source: "status",
          lastUpdatedAt: 1,
        },
      }),
      sessionKey,
    );
    const f = fixture(entry.acp, sessionKey);
    installMutableEntry(entry);
    const result = await f.close({ ...resetOptions, clearMeta: false });
    expect(result.runtimeClosed).toBe(true);
    expect(entry.acp.state).toBe("idle");
    expect(entry.acp.lastError).toBeUndefined();
    expectRecordFields(entry.acp.identity, {
      state: "pending",
      acpxRecordId: sessionKey,
      source: "status",
    });
    expect(entry.acp.identity).not.toHaveProperty("acpxSessionId");
    expect(entry.acp.identity).not.toHaveProperty("agentSessionId");
    f.runtimeState.ensureSession.mockClear().mockResolvedValue({
      sessionKey,
      backend: "acpx",
      runtimeSessionName: "runtime-fresh",
      acpxRecordId: sessionKey,
      backendSessionId: "acpx-session-fresh",
    });
    await f.run("fresh turn", "r-fresh");
    expect(f.runtimeState.prepareFreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, agentId: "claude" }),
    );
    expectRecordFields(mockCallArg(f.runtimeState.ensureSession), { sessionKey });
    expect(mockCallArg(f.runtimeState.ensureSession).resumeSessionId).toBeUndefined();
    expect(f.runtimeState.prepareFreshSession.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(f.runtimeState.ensureSession.mock.invocationCallOrder[0], "fresh ensure call"),
    );
    expect(entry.acp.identity?.acpxSessionId).toBe("acpx-session-fresh");
  });

  it("skips runtime re-ensure when discarding a pending persistent session", async () => {
    const runtimeState = createRuntime();
    const sessionKey = bindingSessionKey;
    hoisted.getAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtimeState.runtime });
    const entry = sessionEntry(
      readySessionMeta({
        agent: "claude",
        identity: {
          state: "pending",
          acpxRecordId: sessionKey,
          source: "ensure",
          lastUpdatedAt: Date.now(),
        },
      }),
      sessionKey,
    );
    installMutableEntry(entry);
    const result = await new AcpSessionManager().closeSession({
      cfg: baseCfg,
      sessionKey,
      ...resetOptions,
      clearMeta: false,
    });
    expect(result.runtimeClosed).toBe(false);
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, agentId: "claude" }),
    );
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.close).not.toHaveBeenCalled();
    expectRecordFields(entry.acp.identity, {
      state: "pending",
      acpxRecordId: sessionKey,
      source: "ensure",
    });
    expect(entry.acp.identity).not.toHaveProperty("acpxSessionId");
    expect(entry.acp.identity).not.toHaveProperty("agentSessionId");
  });

  it("surfaces backend failures raised after a done event", async () => {
    const f = fixture();
    f.runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done" };
      throw new Error("acpx exited with code 1");
    });
    await expectRejectedRecord(f.run("do work", "run-1"), {
      code: "ACP_TURN_FAILED",
      message: "acpx exited with code 1",
    });
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("error");
    expect(states.at(-1)).toBe("error");
  });

  it("does not fail reset close recovery when backend lookup also throws", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue(sessionEntry());
    failBackendLookup(
      "ACP_BACKEND_MISSING",
      "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
    );
    const result = await new AcpSessionManager().closeSession({
      ...target,
      ...resetOptions,
      clearMeta: false,
    });
    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("not configured");
    expect(result.metaCleared).toBe(false);
  });

  it("prepares a fresh session during reset recovery even when the backend is unhealthy", async () => {
    const runtimeState = createRuntime();
    const sessionKey = "agent:claude:acp:session-1";
    hoisted.readAcpSessionEntryMock.mockReturnValue(
      sessionEntry(readySessionMeta({ agent: "claude" }), sessionKey),
    );
    failBackendLookup(
      "ACP_BACKEND_UNAVAILABLE",
      "ACP runtime backend is currently unavailable. Try again in a moment.",
    );
    hoisted.getAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtimeState.runtime });
    const result = await new AcpSessionManager().closeSession({
      cfg: baseCfg,
      sessionKey,
      ...resetOptions,
      clearMeta: false,
    });
    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("currently unavailable");
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, agentId: "claude" }),
    );
  });

  it("surfaces metadata clear errors during closeSession", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue(sessionEntry());
    failBackendLookup(
      "ACP_BACKEND_MISSING",
      "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
    );
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk locked"));
    await expect(
      new AcpSessionManager().closeSession({
        ...target,
        reason: "manual-close",
        allowBackendUnavailable: true,
        clearMeta: true,
      }),
    ).rejects.toThrow("disk locked");
  });
});
