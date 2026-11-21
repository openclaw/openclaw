import { expect, it, vi } from "vitest";
import { bindMemoryProvider } from "../../plugins/memory-provider-adapter.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runPostCompactionSideEffects } from "./compaction-hooks.js";
import { createMaintenanceGate as gate } from "./context-engine-maintenance.fixtures.test-support.js";

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

const sessionFile = "synthetic-compaction";
const session = {
  agentId: "main",
  sessionId: "compaction-handoff",
  sessionKey: "agent:main:compaction-handoff",
};

it.each(["allow", "refuse"] as const)(
  "awaits post-compaction authority before publishing (%s)",
  async (decision) => {
    emitSessionTranscriptUpdate.mockClear();
    using authority = gate();
    const pending = runPostCompactionSideEffects({
      sessionFile,
      assertActive: () => authority.run(() => {}),
    });
    await authority.entered.promise;
    expect(emitSessionTranscriptUpdate).not.toHaveBeenCalled();
    if (decision === "refuse") {
      const failure = new Error("Compaction owner retired");
      const rejected = expect(pending).rejects.toBe(failure);
      authority.release.reject(failure);
      await rejected;
      expect(emitSessionTranscriptUpdate).not.toHaveBeenCalled();
    } else {
      authority.release.resolve();
      await pending;
      expect(emitSessionTranscriptUpdate).toHaveBeenCalledExactlyOnceWith({
        sessionFile,
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
    using acquisition = gate();
    const finishSync = createDeferredCore();
    const providerClosed = createDeferredCore();
    using admission = gate();
    let callerActive = true;
    const sync = vi.fn(() => finishSync.promise);
    const close = vi.fn(async () => providerClosed.resolve());
    const assertCurrent = () => {
      if (!callerActive) {
        throw new Error("compaction caller retired");
      }
    };
    prepareRead.mockReset();
    if (native) {
      prepareRead.mockImplementationOnce(() => admission.run(() => {}));
    }
    const acquire = async () => {
      return acquisition.run(() =>
        native
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
                {
                  authority: { kind: "host", operation: "post-compaction-refresh" },
                  assertCurrent,
                },
              ),
            }
          : { manager: { sync } },
      );
    };
    (native ? getMemoryProvider : getMemorySearchManager).mockImplementationOnce(acquire);
    const foreground = runPostCompactionSideEffects({
      config: { agents: { defaults: { compaction: { postIndexSync: "async" } } } },
      sessionFile,
      ...session,
      assertActive: assertCurrent,
    }).then(() => {
      callerActive = false;
    });
    try {
      await acquisition.entered.promise;
      if (revoked && !native) {
        callerActive = false;
      }
      const completion = revoked
        ? expect(foreground).rejects.toThrow("compaction caller retired")
        : foreground;
      acquisition.release.resolve();
      if (native) {
        await admission.entered.promise;
        // Queue the assertion after any foreground completion already admitted by the caller.
        await Promise.resolve();
        await Promise.resolve();
        expect(callerActive).toBe(true);
        expect(sync).not.toHaveBeenCalled();
        if (revoked) {
          callerActive = false;
        }
        admission.release.resolve();
      }
      await completion;
      if (revoked) {
        expect(sync).not.toHaveBeenCalled();
      } else {
        if (native) {
          expect(sync).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
        } else {
          expect(sync).toHaveBeenCalledExactlyOnceWith({
            reason: "post-compaction",
            sessions: [session],
          });
        }
        finishSync.resolve();
        await sync.mock.results[0]?.value;
      }
      if (native) {
        await providerClosed.promise;
        expect(close).toHaveBeenCalledOnce();
      }
    } finally {
      acquisition.release.resolve();
      admission.release.resolve();
      finishSync.resolve();
      await foreground.catch(() => {});
      memoryKind.native = false;
    }
  },
);

it("awaits archive-file memory sync before settling", async () => {
  memoryKind.native = false;
  getMemorySearchManager.mockClear();
  using syncing = gate();
  const sync = vi.fn((_params?: unknown) => syncing.run(() => {}));
  getMemorySearchManager.mockResolvedValueOnce({ manager: { sync } });
  let settled = false;
  const resultPromise = runPostCompactionSideEffects({
    config: { agents: { defaults: { compaction: { postIndexSync: "await" } } } },
    agentId: "main",
    sessionFile,
    sessionKey: "agent:main:sync-mode",
  });
  void resultPromise.then(() => {
    settled = true;
  });
  try {
    await syncing.entered.promise;
    expect(sync).toHaveBeenCalledExactlyOnceWith({
      archiveFiles: [sessionFile],
      reason: "post-compaction",
    });
    expect(settled).toBe(false);
    syncing.release.resolve();
    await resultPromise;
    expect(settled).toBe(true);
  } finally {
    syncing.release.resolve();
    await resultPromise;
  }
});
