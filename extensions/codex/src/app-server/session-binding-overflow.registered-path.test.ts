import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Integration proof for the Codex binding overflow recovery through the
// registered plugin path (#125913): the extension entry builds the binding
// store and its recovery adapter itself from api.runtime.state. The openers
// delegate to the plugin-state test factories, which run the same
// worker-backed SQLite stores with fixture module resolution (the production
// wiring additionally requires the Gateway host broker, which no in-process
// test has). The only behavioral knob is clamping the binding namespace's
// maxEntries so the 50,000-row production cap becomes fillable; the lazy
// adapter, the recovery sweep, and authority-bound deletes are the shipped
// code paths.
import { createNativeSessionBindingScope } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRuntimeMock,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexPlugin from "../../index.js";
import { CODEX_APP_SERVER_BINDING_NAMESPACE } from "./session-binding-meta.js";
import {
  bindingStoreKey,
  type CodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

const captured = vi.hoisted(() => ({
  bindingStore: undefined as CodexAppServerBindingStore | undefined,
}));

// The session catalog receives the composed binding store from the entry;
// capturing that argument is how the test reaches the production assembly
// without re-constructing it by hand. The catalog's own registrations are
// covered by their own suites and are not needed here.
vi.mock("../session-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-catalog.js")>();
  return {
    ...actual,
    registerCodexSessionCatalog: (params: { bindingStore: CodexAppServerBindingStore }) => {
      captured.bindingStore = params.bindingStore;
    },
  };
});

const TEST_CAPACITY = 3;

function clampBindingCapacity<T extends { namespace?: string; maxEntries?: number }>(
  options: T,
): T {
  return options?.namespace === CODEX_APP_SERVER_BINDING_NAMESPACE
    ? { ...options, maxEntries: TEST_CAPACITY }
    : options;
}

async function withRegisteredCodexBindingStore(
  run: (ctx: {
    bindingStore: CodexAppServerBindingStore;
    syncBindingStore: PluginStateSyncKeyedStore<StoredCodexAppServerBinding>;
    revokedError?: Error;
  }) => Promise<void>,
  options?: { revokeAtWorkerAdmission?: boolean },
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-binding-entry-"));
  // Revocation rig: the sweep is the only pager on this namespace, so a page
  // followed by an observe marks the exact window between the failed capacity
  // insert and the recovery delete. The revocation lands there; the delete's
  // authority-bound store then refuses at its first post-open admission,
  // which is the worker's final admission gate.
  let paged = false;
  let revoked = false;
  const revokedError = options?.revokeAtWorkerAdmission
    ? new Error("session authority revoked")
    : undefined;
  try {
    const withFixtureEnv = <T extends object>(fixture: T) => ({
      ...fixture,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const runtime = createPluginRuntimeMock({
      state: {
        // Mirrors the production openKeyedStoreV2: the authority folds into
        // the store's admission checks at open time.
        openKeyedStoreV2: <T>(
          storeOptions: OpenAsyncKeyedStoreOptions,
          authority?: PluginStateActionAuthority,
        ) => {
          // Per store instance: the factory runs assertCurrent once at open,
          // every operation admission re-runs it. A revocation armed after
          // open therefore only fails admissions, never the open itself.
          let opened = false;
          const store = createPluginStateKeyedStoreV2ForTests<T>(
            "codex",
            withFixtureEnv(clampBindingCapacity(storeOptions)),
            {
              assertCurrent: () => {
                if (!opened) {
                  opened = true;
                } else if (revoked) {
                  throw revokedError ?? new Error("session authority revoked");
                }
                authority?.assertCurrent();
              },
              sessionEntryCurrent: authority?.sessionEntryCurrent,
            },
          );
          if (storeOptions?.namespace === CODEX_APP_SERVER_BINDING_NAMESPACE && revokedError) {
            const page = store.entriesInKeyRange?.bind(store);
            if (page) {
              store.entriesInKeyRange = (range) => {
                paged = true;
                return page(range);
              };
            }
            const observe = store.observe?.bind(store);
            if (observe) {
              store.observe = (key) => {
                if (paged) {
                  revoked = true;
                }
                return observe(key);
              };
            }
          }
          return store;
        },
        openSyncKeyedStore: (syncOptions) =>
          createPluginStateSyncKeyedStoreForTests(
            "codex",
            withFixtureEnv(clampBindingCapacity(syncOptions)),
          ),
      },
    });
    const api = createTestPluginApi({
      id: "codex",
      rootDir: fileURLToPath(new URL("../../", import.meta.url)),
      config: { plugins: { entries: { codex: { enabled: true } } } },
      runtime,
    });
    codexPlugin.register(api);
    const bindingStore = captured.bindingStore;
    expect(bindingStore).toBeDefined();
    // Test-side observer on the same namespace: the entry opens its sync
    // handle lazily on first lookup, so seeding and assertions use a sibling
    // handle on the same SQLite file (the production stores do the same).
    const syncBindingStore = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>(
      "codex",
      withFixtureEnv(
        clampBindingCapacity({
          namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
          maxEntries: 0,
          overflowPolicy: "reject-new" as const,
        }),
      ),
    );
    const live = { kind: "conversation" as const, bindingId: "live" };
    await bindingStore!.mutate(live, {
      kind: "set",
      binding: { threadId: "thread-live", cwd: "/repo" },
    });
    await run({
      bindingStore: bindingStore!,
      syncBindingStore,
      revokedError,
    });
  } finally {
    // Close the worker and cached database handles before removing the
    // directory; removing first fails teardown with EBUSY on Windows.
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// Two rows stay, one cleared row is disposable, capacity is 3: the fresh
// session's lease insert is the fourth row and overflows.
function fillToCapacity(store: PluginStateSyncKeyedStore<StoredCodexAppServerBinding>) {
  store.register("session:main:abandoned", {
    version: 1,
    state: "cleared",
    sessionId: "abandoned-session",
  } as StoredCodexAppServerBinding);
  store.register("session:main:occupied", {
    version: 1,
    state: "active",
    sessionId: "occupied-session",
  } as StoredCodexAppServerBinding);
}

afterEach(() => {
  captured.bindingStore = undefined;
  resetPluginStateStoreForTests();
  resetPluginRuntimeStateForTest();
});

describe("Codex binding overflow recovery through the registered plugin path", () => {
  it("recovers a fresh session's lease admission at capacity", async () => {
    await withRegisteredCodexBindingStore(async ({ bindingStore, syncBindingStore }) => {
      fillToCapacity(syncBindingStore);

      let runCalls = 0;
      let rowDuringLease: unknown;
      const fresh = { kind: "conversation" as const, bindingId: "fresh" };
      // A real prepared authority rides the whole path: lease admission, the
      // sweep's prepareMutation, and the delete's worker-bound write.
      const authority = createNativeSessionBindingScope(() => {});
      const result = await bindingStore.withLease(
        fresh,
        async () => {
          runCalls += 1;
          // The lease record exists while held; it is released on completion,
          // so it can only be observed from inside the callback.
          rowDuringLease = syncBindingStore.lookup(bindingStoreKey(fresh));
          return "started";
        },
        { authority },
      );

      expect(result).toBe("started");
      expect(runCalls).toBe(1);
      expect(rowDuringLease).toBeDefined();
      // The sweep shed exactly the disposable row through the registered
      // adapter; both kept rows survive.
      expect(syncBindingStore.lookup("session:main:abandoned")).toBeUndefined();
      expect(syncBindingStore.lookup("session:main:occupied")).toBeDefined();
      expect(bindingStore.read({ kind: "conversation", bindingId: "live" })).toMatchObject({
        threadId: "thread-live",
      });
    });
  });

  it("rejects a queued delete at final worker admission when authority lapses mid-recovery", async () => {
    await withRegisteredCodexBindingStore(
      async ({ bindingStore, syncBindingStore, revokedError }) => {
        fillToCapacity(syncBindingStore);

        // The caller's authority is current at lease admission; the lapse
        // lands while the sweep pages and observes, so the delete is already
        // queued when the admission gate refuses it.
        const authority = createNativeSessionBindingScope(() => {});
        let runCalls = 0;
        await expect(
          bindingStore.withLease(
            { kind: "conversation", bindingId: "fresh" },
            async () => {
              runCalls += 1;
            },
            { authority },
          ),
        ).rejects.toBe(revokedError);

        expect(runCalls).toBe(0);
        // Zero deletes: the disposable row survives the refused admission.
        expect(syncBindingStore.lookup("session:main:abandoned")).toBeDefined();
      },
      { revokeAtWorkerAdmission: true },
    );
  });
});
