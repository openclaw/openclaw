import { expect, it, vi } from "vitest";
import { bindMemoryProvider } from "../../plugins/memory-provider-adapter.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runPostCompactionSideEffects } from "./compaction-hooks.js";

const {
  emitSessionTranscriptUpdate,
  getMemorySearchManager,
  getMemoryProvider,
  memoryKind,
  prepareRead,
} = vi.hoisted(() => ({
  emitSessionTranscriptUpdate: vi.fn(),
  getMemorySearchManager: vi.fn(),
  getMemoryProvider: vi.fn(),
  memoryKind: { native: false },
  prepareRead: vi.fn(),
}));
vi.mock("../../sessions/transcript-events.js", () => ({ emitSessionTranscriptUpdate }));
// mock-isolation: Keep acquisition under the test's control without loading the plugin registry.
vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManagerCore: getMemorySearchManager,
  getActiveMemoryProviderCore: getMemoryProvider,
}));
// mock-isolation: Select the native or legacy lifecycle without changing process-wide plugin state.
vi.mock("../../plugins/memory-state.js", () => ({
  resolveLoadedMemoryProviderKind: () => (memoryKind.native ? "native" : undefined),
}));
// mock-isolation: Exercise the real provider adapter with a controlled pending audience publication.
vi.mock("../../plugins/memory-audience.js", () => ({
  prepareMemoryCallerRead: prepareRead,
  assertMemoryCallerCurrent: (context: { assertCurrent: () => void }) => context.assertCurrent(),
}));
// mock-isolation: Enable session indexing without loading embedding providers or user configuration.
vi.mock("../memory-search.js", () => ({
  resolveMemorySearchIndexConfig: () => ({
    sources: ["sessions"],
    sync: { sessions: { postCompactionForce: true } },
  }),
}));

it.each(["allow", "refuse"] as const)(
  "awaits post-compaction authority before publishing (%s)",
  async (decision) => {
    emitSessionTranscriptUpdate.mockClear();
    const entered = createDeferredCore();
    const authority = createDeferredCore();
    const pending = runPostCompactionSideEffects({
      sessionFile: "synthetic-compaction",
      assertActive: async () => {
        entered.resolve();
        await authority.promise;
      },
    });
    await entered.promise;
    expect(emitSessionTranscriptUpdate).not.toHaveBeenCalled();
    if (decision === "refuse") {
      const failure = new Error("Compaction owner retired");
      const rejected = expect(pending).rejects.toBe(failure);
      authority.reject(failure);
      await rejected;
      expect(emitSessionTranscriptUpdate).not.toHaveBeenCalled();
    } else {
      authority.resolve();
      await pending;
      expect(emitSessionTranscriptUpdate).toHaveBeenCalledExactlyOnceWith({
        sessionFile: "synthetic-compaction",
        sessionKey: undefined,
      });
    }
  },
);

it.each([
  { native: false, revoked: false },
  { native: false, revoked: true },
  { native: true, revoked: false },
  { native: true, revoked: true },
])(
  "hands async indexing to its owner before foreground retirement (native=$native, revoked=$revoked)",
  async ({ native, revoked }) => {
    memoryKind.native = native;
    const managerRequested = createDeferredCore();
    const managerReady = createDeferredCore();
    const authorityAfterOpen = createDeferredCore();
    const finishSync = createDeferredCore();
    const providerClosed = createDeferredCore();
    const admissionEntered = createDeferredCore();
    const admissionReady = createDeferredCore();
    let managerOpened = false;
    let callerActive = true;
    let indexed = false;
    const sync = vi.fn(async () => {
      await finishSync.promise;
      indexed = true;
    });
    const close = vi.fn(async () => {
      providerClosed.resolve();
    });
    const assertCurrent = () => {
      if (!callerActive) {
        throw new Error("compaction caller retired");
      }
    };
    prepareRead.mockReset();
    if (native) {
      prepareRead.mockImplementationOnce(() => {
        admissionEntered.resolve();
        return admissionReady.promise;
      });
    }
    const acquire = async () => {
      managerRequested.resolve();
      await managerReady.promise;
      managerOpened = true;
      return native
        ? {
            provider: bindMemoryProvider(
              {
                capabilities: {
                  sources: ["sessions"],
                  candidates: [],
                  pagination: false,
                  projectFilter: false,
                },
                search: async () => ({ hits: [] }),
                get: async () => ({ status: "not_found" }),
                health: async () => ({ status: "ready" }),
                refresh: sync,
                close,
              },
              "test-memory",
              { authority: { kind: "host", operation: "post-compaction-refresh" }, assertCurrent },
            ),
          }
        : { manager: { sync } };
    };
    (native ? getMemoryProvider : getMemorySearchManager).mockImplementationOnce(acquire);
    const foreground = runPostCompactionSideEffects({
      config: { agents: { defaults: { compaction: { postIndexSync: "async" } } } },
      agentId: "main",
      sessionKey: "agent:main:compaction-handoff",
      sessionId: "compaction-handoff",
      sessionFile: "synthetic-compaction",
      assertActive: () => {
        if (managerOpened) {
          authorityAfterOpen.resolve();
        }
        assertCurrent();
      },
    }).then(() => {
      callerActive = false;
    });
    try {
      await managerRequested.promise;
      if (revoked && !native) {
        callerActive = false;
      }
      const completion = revoked
        ? expect(foreground).rejects.toThrow("compaction caller retired")
        : foreground;
      managerReady.resolve();
      if (native) {
        await admissionEntered.promise;
        // Queue the assertion after any foreground completion already admitted by the caller.
        await Promise.resolve();
        await Promise.resolve();
        expect(callerActive).toBe(true);
        expect(sync).not.toHaveBeenCalled();
        if (revoked) {
          callerActive = false;
        }
        admissionReady.resolve();
      }
      await completion;
      await authorityAfterOpen.promise;
      if (revoked) {
        expect(sync).not.toHaveBeenCalled();
      } else {
        if (native) {
          expect(sync).toHaveBeenCalledExactlyOnceWith();
          expect(close).not.toHaveBeenCalled();
        } else {
          expect(sync).toHaveBeenCalledExactlyOnceWith({
            reason: "post-compaction",
            sessions: [
              {
                agentId: "main",
                sessionId: "compaction-handoff",
                sessionKey: "agent:main:compaction-handoff",
              },
            ],
          });
        }
        expect(indexed).toBe(false);
        finishSync.resolve();
        await sync.mock.results[0]?.value;
        expect(indexed).toBe(true);
      }
      if (native) {
        await providerClosed.promise;
        expect(close).toHaveBeenCalledOnce();
      }
    } finally {
      managerReady.resolve();
      admissionReady.resolve();
      finishSync.resolve();
      await foreground.catch(() => {});
      memoryKind.native = false;
    }
  },
);

it.each(["await", "async"] as const)(
  "settles post-compaction memory sync in %s mode",
  async (mode) => {
    memoryKind.native = false;
    getMemorySearchManager.mockClear();
    const syncStarted = createDeferredCore<unknown>();
    const syncRelease = createDeferredCore();
    const sync = vi.fn(async (params?: unknown) => {
      syncStarted.resolve(params);
      await syncRelease.promise;
    });
    const managerRequested = createDeferredCore();
    const managerGate = createDeferredCore<{ manager: { sync: typeof sync } }>();
    getMemorySearchManager.mockImplementationOnce(async () => {
      managerRequested.resolve();
      return mode === "async" ? await managerGate.promise : { manager: { sync } };
    });
    let settled = false;
    const resultPromise = runPostCompactionSideEffects({
      config: { agents: { defaults: { compaction: { postIndexSync: mode } } } },
      agentId: "main",
      sessionKey: "agent:main:sync-mode",
      sessionFile: "synthetic-compaction",
    });
    void resultPromise.then(() => {
      settled = true;
    });
    try {
      await managerRequested.promise;
      if (mode === "async") {
        expect(getMemorySearchManager).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        expect(sync).not.toHaveBeenCalled();
        managerGate.resolve({ manager: { sync } });
      }
      await expect(syncStarted.promise).resolves.toEqual({
        archiveFiles: ["synthetic-compaction"],
        reason: "post-compaction",
      });
      if (mode === "async") {
        await resultPromise;
      }
      expect(settled).toBe(mode === "async");
      syncRelease.resolve();
      await resultPromise;
      expect(settled).toBe(true);
    } finally {
      managerGate.resolve({ manager: { sync } });
      syncRelease.resolve();
      await resultPromise;
    }
  },
);
