import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement as awaitGate,
  createDeferred,
} from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { getActiveAcpTurnCount, listActiveAcpSessionsForOwner } from "./active-turns.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectCalledWith,
  extractStateUpsertPersistenceOptions,
  extractStatesFromUpserts,
  flushMicrotasks,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  managerFixture,
  mockParentedAcpSessionEntries,
  readySessionMeta,
  resolvedIdentity,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager", () => {
  installAcpSessionManagerTestLifecycle();
  const target = { cfg: baseCfg, sessionKey: "agent:codex:acp:session-1" };
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
    const { runtimeState, manager, run: runTurn } = managerFixture(sessionKey, meta);
    const run = (
      text: string,
      requestId: string,
      overrides: Partial<Parameters<AcpSessionManager["runTurn"]>[0]> = {},
    ) => runTurn({ text, requestId, ...overrides });
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

  function holdTurn(
    runtime: ReturnType<typeof createRuntime>,
    requestId?: string,
    progress: AcpRuntimeEvent[] = [],
  ) {
    const entered = createDeferred();
    const release = createDeferred();
    runtime.runTurn.mockImplementation(async function* (input) {
      if (!requestId || input.requestId === requestId) {
        entered.resolve();
        for (const event of progress) {
          yield event;
        }
        await release.promise;
      }
      yield { type: "done" };
    });
    return { entered, release };
  }

  it("marks ACP-shaped sessions without metadata as stale", () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue(null);
    const resolved = new AcpSessionManager().resolveSession(target);
    expect(resolved).toMatchObject({
      kind: "stale",
      error: {
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining("ACP metadata is missing"),
      },
    });
    expect(hoisted.readAcpSessionEntryMock.mock.calls[0]?.[0]).toMatchObject({
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
    expect(hoisted.readAcpSessionEntryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        cfg,
        sessionKey: "agent:main:main",
      }),
    );
    expect(f.runtimeState.ensureSession.mock.calls[0]?.[0]).toMatchObject({
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
      const { entered: streamEntered, release: releaseStream } = holdTurn(f.runtimeState);
      const onElicitation = vi.fn(async () => ({ action: "cancel" as const }));
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
      const turn = f.run("slow init", "init-window-acp-turn", {
        sessionKey: childSessionKey,
        onElicitation,
      });
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
      expect(f.runtimeState.runTurn.mock.calls[0]?.[0].onElicitation).toBe(onElicitation);
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
      mockParentedAcpSessionEntries({
        childSessionKey,
        parentSessionKey: ownerSessionKey,
        label: "Retry cleanup",
      });
      const read = expectDefined(
        hoisted.readAcpSessionEntryMock.getMockImplementation(),
        "parented fixture",
      );
      hoisted.readAcpSessionEntryMock.mockImplementation((input: { sessionKey?: string }) => {
        if (input.sessionKey === childSessionKey && initialTurnFailed) {
          throw new Error("session store unavailable");
        }
        return read(input);
      });
      await expect(
        f.run("stale resume", "retry-cleanup-failure-acp-turn", { sessionKey: childSessionKey }),
      ).rejects.toThrow("session store unavailable");
      expect(f.runtimeState.runTurn).toHaveBeenCalledOnce();
      expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([]);
    });
  }, 300_000);

  it("cancels a queued turn promptly when its caller aborts before the actor is free", async () => {
    const f = fixture();
    const { entered: firstTurnStarted, release: releaseFirstTurn } = holdTurn(f.runtimeState, "r1");
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
      abortController.abort();
      await second;
      expect(events).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
      expect(f.runtimeState.runTurn).toHaveBeenCalledOnce();
      releaseFirstTurn.resolve();
      await first;
    } finally {
      abortController.abort();
      releaseFirstTurn.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("times out a hung persistent turn after partial progress without closing the session and lets queued work continue", async () => {
    vi.useFakeTimers();
    try {
      await withStateDirEnv("openclaw-acp-manager-", async () => {
        const f = fixture();
        const state = { currentMeta: readySessionMeta() };
        installMutableAcpSessionMetaUpsert(state);
        mockParentedAcpSessionEntries({
          childSessionKey: target.sessionKey,
          parentSessionKey: "agent:main:main",
          state,
        });
        const { entered: firstTurnStarted } = holdTurn(f.runtimeState, "r1", [
          { type: "text_delta", text: "Working on it..." },
        ]);
        const cfg = {
          ...baseCfg,
          agents: { defaults: { timeoutSeconds: 1 } },
        } satisfies OpenClawConfig;
        const first = f.run("first", "r1", { cfg });
        void first.catch(() => undefined);
        await firstTurnStarted.promise;
        const second = f.run("second", "r2", { cfg });
        await flushMicrotasks();
        expect(f.runtimeState.runTurn).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(3_500);
        await expect(first).rejects.toMatchObject({
          code: "ACP_TURN_FAILED",
          message: "ACP turn timed out after 1s.",
        });
        await expect(second).resolves.toBeUndefined();
        expect(f.runtimeState.ensureSession).toHaveBeenCalledTimes(1);
        expect(f.runtimeState.runTurn).toHaveBeenCalledTimes(2);
        expect(f.runtimeState.cancel.mock.calls[0]?.[0]).toMatchObject({ reason: "turn-timeout" });
        expect(f.runtimeState.close).not.toHaveBeenCalled();
        const snapshot = f.manager.getObservabilitySnapshot();
        expect(snapshot.runtimeCache.activeSessions).toBe(1);
        expect(snapshot.errorsByCode.ACP_TURN_FAILED).toBe(1);
        expect(snapshot.turns).toMatchObject({ active: 0, completed: 1, failed: 1 });
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

  it.each([
    [
      new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "runtime temporarily unavailable"),
      "temporarily unavailable",
    ],
    [new Error("acpx exited with code 1"), "acpx exited with code 1"],
  ] as const)("tolerates close failure: %s", async (error, notice) => {
    const f = fixture();
    f.runtimeState.close.mockRejectedValueOnce(error);
    hoisted.readAcpSessionEntryMock.mockImplementation(
      ({ sessionKey = "" }: { sessionKey?: string }) =>
        sessionEntry(readySessionMeta({ runtimeSessionName: `runtime:${sessionKey}` }), sessionKey),
    );
    const sessionKey = "agent:codex:acp:session-a";
    await f.run("first", "r1", { sessionKey });
    const result = await f.manager.closeSession({
      cfg: baseCfg,
      sessionKey,
      reason: "manual-close",
      allowBackendUnavailable: true,
    });
    expect(result).toMatchObject({
      runtimeClosed: false,
      runtimeNotice: expect.stringContaining(notice),
    });
    await expect(
      f.run("second", "r2", { sessionKey: "agent:codex:acp:session-b" }),
    ).resolves.toBeUndefined();
    expect(f.runtimeState.ensureSession).toHaveBeenCalledTimes(2);
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
    expect(result).toMatchObject({
      runtimeClosed: false,
      metaCleared: true,
      runtimeNotice: expect.stringContaining("does not support session/close"),
    });
    expectCalledWith(f.runtimeState.prepareFreshSession, { sessionKey, agentId: "openclaw" });
  });

  it.each(["resolved", "pending"] as const)(
    "discards %s persistent identity without resuming it",
    async (identityState) => {
      const pending = identityState === "pending";
      const sessionKey = bindingSessionKey;
      const entry = sessionEntry(
        readySessionMeta({
          agent: "claude",
          ...(pending ? {} : { state: "running" as const, lastError: "stale failure" }),
          identity: pending
            ? {
                state: "pending",
                acpxRecordId: sessionKey,
                source: "ensure",
                lastUpdatedAt: Date.now(),
              }
            : resolvedIdentity({
                acpxRecordId: sessionKey,
                acpxSessionId: "acpx-session-1",
                agentSessionId: "agent-session-1",
              }),
        }),
        sessionKey,
      );
      const f = fixture(entry.acp, sessionKey);
      if (pending) {
        hoisted.requireAcpRuntimeBackendMock.mockReset();
        hoisted.getAcpRuntimeBackendMock.mockReturnValue({
          id: "acpx",
          runtime: f.runtimeState.runtime,
        });
      }
      installMutableEntry(entry);
      const result = await f.close({ ...resetOptions, clearMeta: false });
      expect(result.runtimeClosed).toBe(!pending);
      if (pending) {
        expectCalledWith(f.runtimeState.prepareFreshSession, { sessionKey, agentId: "claude" });
      }
      expect(entry.acp.identity).toMatchObject({
        state: "pending",
        acpxRecordId: sessionKey,
        source: pending ? "ensure" : "status",
      });
      expect(entry.acp.identity).not.toHaveProperty("acpxSessionId");
      expect(entry.acp.identity).not.toHaveProperty("agentSessionId");
      if (pending) {
        expect(f.runtimeState.ensureSession).not.toHaveBeenCalled();
        expect(f.runtimeState.close).not.toHaveBeenCalled();
        return;
      }
      expect([entry.acp.state, entry.acp.lastError]).toEqual(["idle", undefined]);
      f.runtimeState.ensureSession.mockClear().mockResolvedValue({
        sessionKey,
        backend: "acpx",
        runtimeSessionName: "runtime-fresh",
        acpxRecordId: sessionKey,
        backendSessionId: "acpx-session-fresh",
      });
      await f.run("fresh turn", "r-fresh");
      expectCalledWith(f.runtimeState.prepareFreshSession, { sessionKey, agentId: "claude" });
      expect(f.runtimeState.ensureSession.mock.calls[0]?.[0]).toMatchObject({ sessionKey });
      expect(f.runtimeState.ensureSession.mock.calls[0]?.[0].resumeSessionId).toBeUndefined();
      expect(f.runtimeState.prepareFreshSession.mock.invocationCallOrder[0]).toBeLessThan(
        expectDefined(
          f.runtimeState.ensureSession.mock.invocationCallOrder[0],
          "fresh ensure call",
        ),
      );
      expect(entry.acp.identity?.acpxSessionId).toBe("acpx-session-fresh");
    },
  );

  it("surfaces backend failures raised after a done event", async () => {
    const f = fixture();
    f.runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done" };
      throw new Error("acpx exited with code 1");
    });
    await expect(f.run("do work", "run-1")).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "acpx exited with code 1",
    });
    const states = extractStatesFromUpserts();
    expect(states).toEqual(expect.arrayContaining(["running", "error"]));
    expect(states.at(-1)).toBe("error");
  });

  it.each([
    ["codex", "ACP_BACKEND_MISSING", "not configured"],
    ["claude", "ACP_BACKEND_UNAVAILABLE", "currently unavailable"],
  ] as const)("recovers reset close for %s when lookup returns %s", async (agent, code, notice) => {
    const runtimeState = createRuntime();
    const sessionKey = `agent:${agent}:acp:session-1`;
    hoisted.readAcpSessionEntryMock.mockReturnValue(
      sessionEntry(readySessionMeta({ agent }), sessionKey),
    );
    failBackendLookup(code, `ACP runtime backend is ${notice}.`);
    if (code === "ACP_BACKEND_UNAVAILABLE") {
      hoisted.getAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
    }
    const result = await new AcpSessionManager().closeSession({
      cfg: baseCfg,
      sessionKey,
      ...resetOptions,
      clearMeta: false,
    });
    expect(result).toMatchObject({
      runtimeClosed: false,
      runtimeNotice: expect.stringContaining(notice),
    });
    if (code === "ACP_BACKEND_UNAVAILABLE") {
      expectCalledWith(runtimeState.prepareFreshSession, { sessionKey, agentId: agent });
    } else {
      expect(result.metaCleared).toBe(false);
    }
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

  it.each(["signal failure", "abort", "actor replacement"] as const)(
    "releases only the current native turn when preflight ends with %s",
    async (reason) => {
      await withStateDirEnv("openclaw-acp-preflight-", async () => {
        const sessionKey = "agent:codex:acp:preflight-child";
        const parentSessionKey = "agent:main:main";
        const requestId = "preflight-run";
        const { runtimeState: runtime, manager, run } = managerFixture(sessionKey);
        mockParentedAcpSessionEntries({
          childSessionKey: sessionKey,
          parentSessionKey,
        });
        const reached = createDeferred();
        const release = createDeferred();
        const failure = new Error(`ACP preflight ${reason}`);
        const read = hoisted.readAcpSessionEntryAsyncMock.getMockImplementation();
        const readSpy = hoisted.readAcpSessionEntryAsyncMock;
        if (reason !== "signal failure") {
          readSpy.mockImplementationOnce(async (params) => {
            reached.resolve();
            await release.promise;
            return await read?.(params);
          });
        }
        const signalSpy =
          reason === "signal failure"
            ? vi
                .spyOn(sessionStateEvents, "recordSessionHumanDirectMessage")
                .mockImplementationOnce(async () => {
                  reached.resolve();
                  await release.promise;
                  throw failure;
                })
            : undefined;
        const controller = new AbortController();
        const input = { text: "Prepare the child turn", requestId };
        const pending = run({ ...input, signal: controller.signal });
        const outcome = Promise.allSettled([pending]);
        const successorStarted = createDeferred();
        const releaseSuccessor = createDeferred();
        const successorReadReached = createDeferred();
        const releaseSuccessorRead = createDeferred();
        let successor: Promise<void> | undefined;
        try {
          await awaitGate(reached.promise, outcome, "Turn settled before preflight");
          expect(getActiveAcpTurnCount()).toBe(1);
          expect(listActiveAcpSessionsForOwner(parentSessionKey)).toEqual(
            reason === "signal failure" ? [sessionKey] : [],
          );
          expect(runtime.ensureSession).not.toHaveBeenCalled();
          expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
          if (reason === "abort") {
            controller.abort();
          } else if (reason === "actor replacement") {
            await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
              cfg: baseCfg,
              sessionKey,
              reason: "session-reset",
            });
            runtime.runTurn.mockImplementationOnce(async function* () {
              successorStarted.resolve();
              await releaseSuccessor.promise;
              yield { type: "done" as const };
            });
            readSpy.mockImplementationOnce(async (params) => {
              successorReadReached.resolve();
              await releaseSuccessorRead.promise;
              return await read?.(params);
            });
            successor = run(input);
            void successor.catch(() => {});
            await flushMicrotasks();
            expect(runtime.ensureSession).not.toHaveBeenCalled();
          }
          const metadataWrites = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
          release.resolve();
          expect(await outcome).toMatchObject([{ status: "rejected" }]);
          if (successor) {
            await successorReadReached.promise;
          }
          expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(metadataWrites);
          releaseSuccessorRead.resolve();
          if (successor) {
            await awaitGate(
              successorStarted.promise,
              successor,
              "Successor settled before starting its stream",
            );
          }
          expect(getActiveAcpTurnCount()).toBe(successor ? 1 : 0);
          expect(listActiveAcpSessionsForOwner(parentSessionKey)).toEqual(
            successor ? [sessionKey] : [],
          );
          expect(
            (await sessionStateEvents.listSessionStateEventsSince(sessionKey, "codex", 0, 200))
              .events,
          ).toMatchObject(
            reason === "signal failure"
              ? [{ kind: "run_failed", runId: requestId, payload: { outcome: "error" } }]
              : [],
          );
          if (successor) {
            releaseSuccessor.resolve();
            await successor;
            expect(getActiveAcpTurnCount()).toBe(0);
            expect(
              (await sessionStateEvents.listSessionStateEventsSince(sessionKey, "codex", 0, 200))
                .events,
            ).toMatchObject([{ kind: "run_completed", runId: requestId }]);
          }
        } finally {
          release.resolve();
          releaseSuccessorRead.resolve();
          releaseSuccessor.resolve();
          await Promise.allSettled([pending, ...(successor ? [successor] : [])]);
          if (read) {
            readSpy.mockImplementation(read);
          }
          signalSpy?.mockRestore();
        }
      });
    },
  );
});
