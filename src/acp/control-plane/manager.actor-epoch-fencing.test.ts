import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";
import type { WriteManagerSessionMeta } from "./manager.types.js";

installAcpSessionManagerTestLifecycle();

const sessionTarget = { cfg: baseCfg, sessionKey: "agent:codex:acp:actor-epoch-fencing" };
const initialization = { ...sessionTarget, agent: "codex", mode: "persistent" as const };

function barrier() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    wait: () => {
      entered.resolve();
      return release.promise;
    },
  };
}

function expectIdle(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function useRuntime() {
  const state = createRuntime();
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
  return state;
}

function createFixture(beforeCommit?: () => Promise<void>, initialMeta?: SessionAcpMeta) {
  const runtimeState = useRuntime();
  let ensureCount = 0;
  let persistedMeta = initialMeta;
  const entry = () =>
    persistedMeta ? { sessionId: "session-1", updatedAt: 1, acp: persistedMeta } : undefined;
  const stored = (key: string) => ({
    sessionKey: key,
    storeSessionKey: key,
    entry: entry(),
    acp: persistedMeta,
  });
  runtimeState.ensureSession.mockImplementation(async (input) => {
    const callNumber = ++ensureCount;
    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime-${callNumber}`,
      backendSessionId: `backend-${callNumber}`,
    };
  });
  hoisted.readAcpSessionEntryMock.mockImplementation(
    ({ sessionKey: key }: { sessionKey: string }) => stored(key),
  );
  hoisted.upsertAcpSessionMetaMock.mockImplementation(
    async (input: Parameters<WriteManagerSessionMeta>[0]) => {
      const next = input.mutate(persistedMeta, entry());
      await beforeCommit?.();
      input.assertCommitAllowed?.();
      if (next !== undefined) {
        persistedMeta = next ?? undefined;
      }
      return persistedMeta ? stored(input.sessionKey) : null;
    },
  );
  return {
    runtimeState,
    manager: new AcpSessionManager(),
    get meta() {
      return persistedMeta;
    },
  };
}

describe("AcpSessionManager actor epoch fencing", () => {
  const { sessionKey } = sessionTarget;

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
      expectIdle(runtime.close, writeSessionMeta);
      expect(runtimeHandles.get(target)?.handle).toBe(handle);
    },
  );

  it.each(["actor", "caller"] as const)(
    "does not start backend work after %s authority expires during the status metadata read",
    async (retired) => {
      const runtime = useRuntime();
      const read = barrier();
      const stored = {
        sessionKey,
        storeSessionKey: sessionKey,
        entry: { sessionId: "held-read", lifecycleRevision: "original", updatedAt: 1 },
        acp: readySessionMeta(),
      };
      hoisted.readAcpSessionEntryMock.mockReturnValue(stored);
      hoisted.readAcpSessionEntryAsyncMock.mockImplementationOnce(async () => {
        await read.wait();
        return stored;
      });
      let current = true;
      const revoked = new Error("status caller authority revoked");
      const manager = new AcpSessionManager();
      const pending = manager.getSessionStatus({
        ...sessionTarget,
        assertActive: () => {
          if (!current) {
            throw revoked;
          }
        },
      });
      let settled = false;
      const outcome = Promise.allSettled([pending]).then(([result]) => {
        settled = true;
        return result;
      });
      try {
        expect(
          await Promise.race([read.entered.then(() => "read"), outcome.then(() => "settled")]),
        ).toBe("read");
        if (retired === "actor") {
          await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
            ...sessionTarget,
            reason: "session-reset",
          });
        } else {
          current = false;
        }
        expect(settled).toBe(false);
        read.release();
        const result = await outcome;
        if (result.status !== "rejected") {
          throw new Error("Expected the retired status read to reject");
        }
        if (retired === "actor") {
          expect(result.reason).toMatchObject({ detailCode: "SESSION_ACTOR_SUPERSEDED" });
        } else {
          expect(result.reason).toBe(revoked);
        }
        expectIdle(
          runtime.ensureSession,
          runtime.getCapabilities,
          runtime.getStatus,
          hoisted.upsertAcpSessionMetaMock,
        );
      } finally {
        read.release();
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
    { operation: "status reconciliation", freshOptions: { model: "fresh-model" } },
  ] as const)(
    "does not let a stale $operation write or clear the fresh actor lane",
    async ({ operation, freshOptions }) => {
      const stale = barrier();
      let pauseNextUpsert = false;
      const fixture = createFixture(async () => {
        if (pauseNextUpsert) {
          pauseNextUpsert = false;
          await stale.wait();
        }
      });
      const { runtimeState, manager } = fixture;
      if (operation === "runtime mode" || operation === "config option") {
        runtimeState.getCapabilities.mockImplementation(async () => {
          await stale.wait();
          return {
            controls: ["session/set_mode", "session/set_config_option", "session/status"],
          };
        });
      }
      if (operation === "option reset") {
        runtimeState.close.mockImplementationOnce(async () => {
          await stale.wait();
        });
      }
      if (operation === "status reconciliation") {
        let statusCalls = 0;
        runtimeState.getStatus.mockImplementation(async () => {
          statusCalls += 1;
          if (statusCalls === 2) {
            await stale.wait();
          }
          return {
            summary: "status=alive",
            backendSessionId: statusCalls === 2 ? "stale-status" : `backend-${statusCalls}`,
            details: { status: "alive" },
          };
        });
      }

      await manager.initializeSession(initialization);

      if (operation === "option update") {
        pauseNextUpsert = true;
      }
      const staleOperation = {
        "runtime mode": () =>
          manager.setSessionRuntimeMode({ ...sessionTarget, runtimeMode: "stale" }),
        "config option": () =>
          manager.setSessionConfigOption({ ...sessionTarget, key: "model", value: "stale-model" }),
        "option update": () =>
          manager.updateSessionRuntimeOptions({
            ...sessionTarget,
            patch: { cwd: "/workspace/stale" },
          }),
        "status reconciliation": () => manager.getSessionStatus(sessionTarget),
        "option reset": () => manager.resetSessionRuntimeOptions(sessionTarget),
      }[operation]();
      await stale.entered;

      await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
        ...sessionTarget,
        reason: "session-reset",
      });
      await manager.initializeSession({
        ...initialization,
        runtimeOptions: freshOptions,
      });

      stale.release();
      await expect(staleOperation).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        detailCode: "SESSION_ACTOR_SUPERSEDED",
      });
      expect(fixture.meta?.runtimeSessionName).toBe("runtime-2");
      expect(fixture.meta?.runtimeOptions).toEqual(freshOptions);
      if (operation === "status reconciliation") {
        expect(fixture.meta?.identity?.acpxSessionId).toBe("backend-2");
        return;
      }

      await manager.runTurn({
        provenance: "system",
        ...sessionTarget,
        text: "fresh follow-up",
        mode: "prompt",
        requestId: "fresh-follow-up",
      });
      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
      expect(runtimeState.runTurn.mock.calls[0]?.[0].handle).toMatchObject({
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

  it("rejects a stale discard token without removing the successor runtime", async () => {
    const state = useRuntime();
    installMutableAcpSessionMetaUpsert({ currentMeta: undefined });
    const manager = new AcpSessionManager();
    const input = initialization;
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

it("captures the expected owner before waiting for the session actor", async () => {
  const sessionKey = "agent:main:acp:close-wait";
  const state = useRuntime();
  const meta = readySessionMeta({ agent: "main" });
  let entry = {
    sessionId: "original",
    lifecycleRevision: "original",
    updatedAt: 1,
    spawnedBy: "agent:main:original-owner",
  };
  hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
    sessionKey,
    storeSessionKey: sessionKey,
    entry,
    acp: meta,
  }));
  const ensure = barrier();
  state.ensureSession.mockImplementation(async () => {
    await ensure.wait();
    return { sessionKey, backend: "acpx", runtimeSessionName: meta.runtimeSessionName };
  });
  const manager = new AcpSessionManager();
  const status = manager.getSessionStatus({ cfg: baseCfg, sessionKey });
  let closing: Promise<unknown> | undefined;
  try {
    await ensure.entered;
    const expectedControlBinding = {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      ownerKey: entry.spawnedBy,
    };
    closing = manager.closeSession({
      cfg: baseCfg,
      sessionKey,
      reason: "terminal-task-cleanup",
      expectedControlBinding,
      discardPersistentState: true,
      allowBackendUnavailable: true,
      clearMeta: true,
    });
    const rejected = expect(closing).rejects.toMatchObject({
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    entry = { ...entry, spawnedBy: "agent:main:replacement-owner" };
    expectedControlBinding.ownerKey = entry.spawnedBy;
    ensure.release();
    await status;
    await rejected;
    expectIdle(state.close, state.prepareFreshSession, hoisted.upsertAcpSessionMetaMock);
  } finally {
    ensure.release();
    await Promise.allSettled([status, closing]);
    await disposeAcpSessionManagerInstance(manager, "fixture-cleanup");
  }
});
it.each(["update", "reset"] as const)(
  "rechecks the admitted requester before an awaited %s commits",
  async (operation) => {
    const commit = barrier();
    let current = true;
    const fixture = createFixture(
      async () => {
        await commit.wait();
      },
      readySessionMeta({ runtimeOptions: { cwd: "/workspace/original" } }),
    );
    const { manager, runtimeState: runtime } = fixture;
    const target = {
      ...sessionTarget,
      assertActive: () => {
        if (!current) {
          throw new Error("requester authority revoked");
        }
      },
    };
    const pending =
      operation === "update"
        ? manager.updateSessionRuntimeOptions({ ...target, patch: { cwd: "/workspace/changed" } })
        : manager.resetSessionRuntimeOptions(target);
    const rejected = expect(pending).rejects.toThrow("requester authority revoked");
    await commit.entered;
    current = false;
    commit.release();
    await rejected;
    expect(fixture.meta?.runtimeOptions).toEqual({ cwd: "/workspace/original" });
    expectIdle(runtime.ensureSession, runtime.close);
  },
);
