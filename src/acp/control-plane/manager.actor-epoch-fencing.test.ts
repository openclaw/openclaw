import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
/** Tests that reset actor rotation fences every ACP metadata-writing operation. */
import { runManagerCloseSession } from "./manager.close-session.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  runResetManagerSessionRuntimeOptions,
  type RuntimeOptionCommandServices,
} from "./manager.runtime-options-commands.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  disposeAcpSessionManagerInstance,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  mockCallArg,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:codex:acp:actor-epoch-fencing";

describe("AcpSessionManager actor epoch fencing", () => {
  installAcpSessionManagerTestLifecycle();

  it.each([
    { operation: "option reset", retired: "actor" },
    { operation: "option reset", retired: "caller" },
    { operation: "session close", retired: "actor" },
    { operation: "session close", retired: "caller" },
  ] as const)(
    "does not close a cached runtime during $operation after $retired retirement at metadata-read settlement",
    async ({ operation, retired }) => {
      const runtime = createRuntime();
      const target = { sessionKey, agentId: "codex" };
      const meta = readySessionMeta();
      const entry = {
        sessionId: "session-1",
        lifecycleRevision: "revision-1",
        updatedAt: 1,
        spawnedBy: "agent:main:main",
      };
      const handle = { sessionKey, backend: "acpx", runtimeSessionName: meta.runtimeSessionName };
      const runtimeHandles = new ManagerRuntimeHandleCache();
      runtimeHandles.set(target, {
        runtime: runtime.runtime,
        handle,
        backend: "acpx",
        agent: "codex",
        mode: "persistent",
      });
      let current = true;
      let readReturned = false;
      let ensured = false;
      const retireAtSettlement = () => {
        if (readReturned) {
          queueMicrotask(() => {
            current = false;
          });
        }
      };
      const assertActive = () => {
        if (retired === "caller") {
          if (!current) {
            throw new Error("ACP caller retired");
          }
          retireAtSettlement();
        }
      };
      const writeSessionMeta = vi.fn(async () => null);
      const services: RuntimeOptionCommandServices = {
        runtimeHandles,
        resolveSession: async () => {
          // Close refreshes its control binding after ensure; retire at that helper's settlement.
          readReturned = operation === "option reset" || ensured;
          return { kind: "ready", ...target, meta, entry };
        },
        ensureRuntimeHandle: async () => {
          if (operation === "option reset") {
            throw new Error("Reset must use the cached handle");
          }
          const cached = runtimeHandles.get(target);
          if (!cached) {
            throw new Error("Expected the retained runtime handle");
          }
          ensured = true;
          return { runtime: cached.runtime, handle: cached.handle, meta };
        },
        writeSessionMeta,
        isCurrentActor: () => {
          if (retired === "actor") {
            retireAtSettlement();
            return current;
          }
          return true;
        },
      };
      const pending =
        operation === "option reset"
          ? runResetManagerSessionRuntimeOptions({
              ...target,
              cfg: baseCfg,
              assertActive,
              ...services,
            })
          : runManagerCloseSession({
              input: {
                ...target,
                cfg: baseCfg,
                assertActive,
                reason: "test-close",
                clearMeta: true,
                expectedControlBinding: {
                  sessionId: entry.sessionId,
                  lifecycleRevision: entry.lifecycleRevision,
                  ownerKey: entry.spawnedBy,
                },
              },
              ...target,
              deps: { getRuntimeBackend: () => ({ id: "acpx", runtime: runtime.runtime }) },
              ...services,
            });
      await expect(pending).rejects.toThrow();
      expect(runtime.close).not.toHaveBeenCalled();
      expect(writeSessionMeta).not.toHaveBeenCalled();
      expect(runtimeHandles.get(target)?.handle).toBe(handle);
    },
  );

  it.each(["actor", "caller"] as const)(
    "does not start backend work after %s authority expires during the status metadata read",
    async (retired) => {
      const runtime = createRuntime();
      const entered = createDeferred();
      const release = createDeferred();
      const stored = {
        sessionKey,
        storeSessionKey: sessionKey,
        entry: { sessionId: "held-read", lifecycleRevision: "original", updatedAt: 1 },
        acp: readySessionMeta(),
      };
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtime.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockReturnValue(stored);
      hoisted.readAcpSessionEntryAsyncMock.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return stored;
      });
      let current = true;
      const revoked = new Error("status caller authority revoked");
      const manager = new AcpSessionManager();
      const pending = manager.getSessionStatus({
        cfg: baseCfg,
        sessionKey,
        assertActive: () => {
          if (!current) {
            throw revoked;
          }
        },
      });
      let settled = false;
      const outcome = pending.then(
        (value) => {
          settled = true;
          return { kind: "success" as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { kind: "error" as const, error };
        },
      );
      try {
        expect(
          await Promise.race([entered.promise.then(() => "read"), outcome.then(() => "settled")]),
        ).toBe("read");
        if (retired === "actor") {
          await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
            cfg: baseCfg,
            sessionKey,
            reason: "session-reset",
          });
        } else {
          current = false;
        }
        expect(settled).toBe(false);
        release.resolve();
        const result = await outcome;
        if (result.kind !== "error") {
          throw new Error("Expected the retired status read to reject");
        }
        if (retired === "actor") {
          expect(result.error).toMatchObject({ detailCode: "SESSION_ACTOR_SUPERSEDED" });
        } else {
          expect(result.error).toBe(revoked);
        }
        expect(runtime.ensureSession).not.toHaveBeenCalled();
        expect(runtime.getCapabilities).not.toHaveBeenCalled();
        expect(runtime.getStatus).not.toHaveBeenCalled();
        expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await outcome;
        await disposeAcpSessionManagerInstance(manager, "test-complete");
      }
    },
  );

  it.each([
    { operation: "runtime mode", freshOptions: { runtimeMode: "fresh" } },
    { operation: "config option", freshOptions: { model: "fresh-model" } },
    { operation: "option update", freshOptions: { cwd: "/workspace/fresh" } },
    { operation: "option reset", freshOptions: { runtimeMode: "fresh" } },
  ])(
    "does not let a stale $operation write or clear the fresh actor lane",
    async ({ operation, freshOptions }) => {
      const runtimeState = createRuntime();
      const releaseStaleOperation = createDeferred();
      const staleOperationEntered = createDeferred();
      let ensureCount = 0;
      let persistedMeta: SessionAcpMeta | undefined;
      let pauseNextUpsert = false;
      let closeCalls = 0;

      runtimeState.ensureSession.mockImplementation(async (input) => {
        const callNumber = ++ensureCount;
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `runtime-${callNumber}`,
          backendSessionId: `backend-${callNumber}`,
        };
      });
      if (operation === "runtime mode" || operation === "config option") {
        runtimeState.getCapabilities.mockImplementation(async () => {
          staleOperationEntered.resolve();
          await releaseStaleOperation.promise;
          return {
            controls: ["session/set_mode", "session/set_config_option", "session/status"],
          };
        });
      }
      if (operation === "option reset") {
        runtimeState.close.mockImplementation(async () => {
          closeCalls += 1;
          if (closeCalls === 1) {
            staleOperationEntered.resolve();
            await releaseStaleOperation.promise;
          }
        });
      }

      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((inputUnknown: unknown) => {
        const key = (inputUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
        return {
          sessionKey: key,
          storeSessionKey: key,
          ...(persistedMeta ? { entry: { sessionId: "session-1", updatedAt: Date.now() } } : {}),
          ...(persistedMeta ? { acp: persistedMeta } : {}),
        };
      });
      hoisted.upsertAcpSessionMetaMock.mockImplementation(async (inputUnknown: unknown) => {
        const input = inputUnknown as {
          sessionKey: string;
          assertCommitAllowed?: () => void;
          mutate: (
            current: SessionAcpMeta | undefined,
            entry: { sessionId: string; updatedAt: number; acp?: SessionAcpMeta } | undefined,
          ) => SessionAcpMeta | null | undefined;
        };
        const current = persistedMeta;
        const entry = current
          ? { sessionId: "session-1", updatedAt: Date.now(), acp: current }
          : undefined;
        const next = input.mutate(current, entry);
        if (pauseNextUpsert) {
          pauseNextUpsert = false;
          staleOperationEntered.resolve();
          await releaseStaleOperation.promise;
        }
        input.assertCommitAllowed?.();
        if (next === null) {
          persistedMeta = undefined;
        } else if (next !== undefined) {
          persistedMeta = next;
        }
        return persistedMeta
          ? {
              sessionKey: input.sessionKey,
              storeSessionKey: input.sessionKey,
              entry: { sessionId: "session-1", updatedAt: Date.now(), acp: persistedMeta },
              acp: persistedMeta,
            }
          : null;
      });

      const manager = new AcpSessionManager();
      await manager.initializeSession({
        cfg: baseCfg,
        sessionKey,
        agent: "codex",
        mode: "persistent",
      });

      if (operation === "option update") {
        pauseNextUpsert = true;
      }
      const staleOperation =
        operation === "runtime mode"
          ? manager.setSessionRuntimeMode({
              cfg: baseCfg,
              sessionKey,
              runtimeMode: "stale",
            })
          : operation === "config option"
            ? manager.setSessionConfigOption({
                cfg: baseCfg,
                sessionKey,
                key: "model",
                value: "stale-model",
              })
            : operation === "option update"
              ? manager.updateSessionRuntimeOptions({
                  cfg: baseCfg,
                  sessionKey,
                  patch: { cwd: "/workspace/stale" },
                })
              : manager.resetSessionRuntimeOptions({
                  cfg: baseCfg,
                  sessionKey,
                });
      await staleOperationEntered.promise;

      await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
        cfg: baseCfg,
        sessionKey,
        reason: "session-reset",
      });
      await manager.initializeSession({
        cfg: baseCfg,
        sessionKey,
        agent: "codex",
        mode: "persistent",
        runtimeOptions: freshOptions,
      });

      releaseStaleOperation.resolve();
      await expect(staleOperation).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        detailCode: "SESSION_ACTOR_SUPERSEDED",
      });
      expect(persistedMeta?.runtimeSessionName).toBe("runtime-2");
      expect(persistedMeta?.runtimeOptions).toEqual(freshOptions);

      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: "fresh follow-up",
        mode: "prompt",
        requestId: "fresh-follow-up",
      });
      expect(ensureCount).toBe(2);
      expect(mockCallArg(runtimeState.runTurn).handle).toMatchObject({
        runtimeSessionName: "runtime-2",
      });
      if (operation === "runtime mode") {
        expect(runtimeState.setMode).not.toHaveBeenCalledWith(
          expect.objectContaining({ mode: "stale" }),
        );
      }
      if (operation === "config option") {
        expect(runtimeState.setConfigOption).not.toHaveBeenCalledWith(
          expect.objectContaining({ value: "stale-model" }),
        );
      }
    },
  );

  it("does not let stale status reconciliation overwrite the fresh actor metadata", async () => {
    const runtimeState = createRuntime();
    const releaseStaleStatus = createDeferred();
    const staleStatusEntered = createDeferred();
    let statusCalls = 0;
    let ensureCount = 0;
    let persistedMeta: SessionAcpMeta | undefined;
    runtimeState.ensureSession.mockImplementation(async (input) => {
      const callNumber = ++ensureCount;
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${callNumber}`,
        backendSessionId: `backend-${callNumber}`,
      };
    });
    runtimeState.getStatus.mockImplementation(async () => {
      statusCalls += 1;
      if (statusCalls === 2) {
        staleStatusEntered.resolve();
        await releaseStaleStatus.promise;
      }
      return {
        summary: "status=alive",
        backendSessionId: statusCalls === 2 ? "stale-status" : `backend-${statusCalls}`,
        details: { status: "alive" },
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((inputUnknown: unknown) => {
      const key = (inputUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        ...(persistedMeta ? { entry: { sessionId: "session-1", updatedAt: Date.now() } } : {}),
        ...(persistedMeta ? { acp: persistedMeta } : {}),
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { sessionId: string; updatedAt: number; acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = persistedMeta;
      const entry = current
        ? { sessionId: "session-1", updatedAt: Date.now(), acp: current }
        : undefined;
      const next = input.mutate(current, entry);
      if (next) {
        persistedMeta = next;
      }
      return persistedMeta
        ? {
            sessionKey: input.sessionKey,
            storeSessionKey: input.sessionKey,
            entry: { sessionId: "session-1", updatedAt: Date.now(), acp: persistedMeta },
            acp: persistedMeta,
          }
        : null;
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });
    const staleStatus = manager.getSessionStatus({
      cfg: baseCfg,
      sessionKey,
    });
    await staleStatusEntered.promise;

    await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
      runtimeOptions: { model: "fresh-model" },
    });

    releaseStaleStatus.resolve();
    await expect(staleStatus).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    expect(persistedMeta?.runtimeSessionName).toBe("runtime-2");
    expect(persistedMeta?.identity?.acpxSessionId).toBe("backend-2");
  });
  it("rejects a stale discard token without removing the successor runtime", async () => {
    const state = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
    installMutableAcpSessionMetaUpsert({ currentMeta: undefined });
    const manager = new AcpSessionManager();
    const input = { cfg: baseCfg, sessionKey, agent: "codex", mode: "persistent" as const };
    await manager.initializeSession(input);
    const old = getAcpSessionResetControls(manager).captureSessionRuntimeOwnership(input);
    await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
      ...input,
      reason: "reset",
      isCurrent: old.isCurrent,
    });
    const fresh = await manager.initializeSession(input);
    const closesBefore = state.close.mock.calls.length;
    await expect(
      getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
        ...input,
        reason: "late reset",
        isCurrent: old.isCurrent,
      }),
    ).rejects.toMatchObject({ detailCode: "SESSION_ACTOR_SUPERSEDED" });
    expect(state.close.mock.calls.length).toBe(closesBefore);
    expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(1);
    expect(fresh.handle).toBeDefined();
    old.release();
  });
});
