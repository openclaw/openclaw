import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  applySessionEntryPatch,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import codexPlugin from "../../index.js";
import { CODEX_APP_SERVER_BINDING_NAMESPACE } from "./session-binding-meta.js";
import {
  bindingStoreKey,
  resolveCodexSessionBinding,
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

// Minimal agent-sqlite fixture: an isolated OPENCLAW_STATE_DIR is all the
// "minimal" scenario needs for the session-entry reads and writes below. The
// plugin state handle is released before the directory is removed so teardown
// does not hit EBUSY on Windows.
async function withAgentEnv<T>(run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-entry-"));
  try {
    return await run({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
  } finally {
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

async function withRegisteredCodexBindingStore(
  run: (ctx: {
    bindingStore: CodexAppServerBindingStore;
    syncBindingStore: PluginStateSyncKeyedStore<StoredCodexAppServerBinding>;
    revokedError?: Error;
    deleteAttempts: { count: number };
  }) => Promise<void>,
  options?: {
    revokeAtWorkerAdmission?: boolean;
    mutateLineageAtDelete?: () => void | Promise<void>;
  },
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-binding-entry-"));
  // Revocation rig: the sweep is the only pager on this namespace, so a page
  // followed by an observe marks the exact window between the failed capacity
  // insert and the recovery delete. Revocation starts only after that
  // observation completes and affects only caller-bound stores, so the
  // unbound read cannot reject before the recovery writer is attempted.
  let paged = false;
  let revoked = false;
  const deleteAttempts = { count: 0 };
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
          // open therefore fails only caller-bound admissions, never the open
          // itself or the unbound observation store.
          let opened = false;
          const store = createPluginStateKeyedStoreV2ForTests<T>(
            "codex",
            withFixtureEnv(clampBindingCapacity(storeOptions)),
            {
              assertCurrent: () => {
                if (!opened) {
                  opened = true;
                } else if (revoked && authority) {
                  throw revokedError ?? new Error("session authority revoked");
                }
                authority?.assertCurrent();
              },
              sessionEntryCurrent: authority?.sessionEntryCurrent,
            },
          );
          if (
            storeOptions?.namespace === CODEX_APP_SERVER_BINDING_NAMESPACE &&
            (revokedError || options?.mutateLineageAtDelete)
          ) {
            if (authority) {
              const compareAndApply = store.compareAndApply?.bind(store);
              if (compareAndApply) {
                store.compareAndApply = async (key, comparison, intent, compareOptions) => {
                  if (intent.operation === "delete") {
                    deleteAttempts.count += 1;
                    await options?.mutateLineageAtDelete?.();
                  }
                  return await compareAndApply(key, comparison, intent, compareOptions);
                };
              }
            }
            const page = store.entriesInKeyRange?.bind(store);
            if (page) {
              store.entriesInKeyRange = (range) => {
                paged = true;
                return page(range);
              };
            }
            const observe = store.observe?.bind(store);
            if (observe) {
              store.observe = async (key) => {
                const observation = await observe(key);
                if (paged && options?.revokeAtWorkerAdmission) {
                  revoked = true;
                }
                return observation;
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
      deleteAttempts,
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
      await withAgentEnv(async (env) => {
        fillToCapacity(syncBindingStore);

        const sessionKey = "agent:main:codex-overflow-real-lineage";
        const read = {
          agentId: "main",
          sessionKey,
          env,
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
        };
        const seed = {
          sessionId: "real-session",
          previousSessionId: "predecessor",
          updatedAt: 1,
        };
        await applySessionEntryPatch({ ...read, patch: seed, fallbackEntry: seed as SessionEntry });
        const resolved = await resolveCodexSessionBinding({
          bindingStore,
          identity: {
            kind: "session",
            agentId: "main",
            sessionId: "real-session",
            sessionKey,
          },
          storePath: read.storePath,
          reclaimStale: false,
        });

        let runCalls = 0;
        let rowDuringLease: unknown;
        const fresh = { kind: "conversation" as const, bindingId: "fresh" };
        try {
          const result = await bindingStore.withLease(
            fresh,
            async () => {
              runCalls += 1;
              rowDuringLease = syncBindingStore.lookup(bindingStoreKey(fresh));
              return "started";
            },
            { authority: resolved.authority },
          );

          expect(result).toBe("started");
          expect(runCalls).toBe(1);
          expect(rowDuringLease).toBeDefined();
          expect(syncBindingStore.lookup("session:main:abandoned")).toBeUndefined();
          expect(syncBindingStore.lookup("session:main:occupied")).toBeDefined();
          expect(bindingStore.read({ kind: "conversation", bindingId: "live" })).toMatchObject({
            threadId: "thread-live",
          });
        } finally {
          resolved.release();
        }
      });
    });
  });

  it("rejects a queued delete at final worker admission when the real session lineage changes", async () => {
    await withAgentEnv(async (env) => {
      const sessionKey = "agent:main:codex-overflow-lineage-fence";
      const read = {
        agentId: "main",
        sessionKey,
        env,
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
      };
      const seed = {
        sessionId: "real-session",
        previousSessionId: "predecessor",
        updatedAt: 1,
      };
      await applySessionEntryPatch({ ...read, patch: seed, fallbackEntry: seed as SessionEntry });

      await withRegisteredCodexBindingStore(
        async ({ bindingStore, syncBindingStore, deleteAttempts }) => {
          fillToCapacity(syncBindingStore);

          const resolved = await resolveCodexSessionBinding({
            bindingStore,
            identity: {
              kind: "session",
              agentId: "main",
              sessionId: "real-session",
              sessionKey,
            },
            storePath: read.storePath,
            reclaimStale: false,
          });

          let runCalls = 0;
          const prepared = await resolved.authority.prepareMutation();
          expect(prepared.sessionEntryCurrent).toBeDefined();
          try {
            await expect(
              bindingStore.withLease(
                { kind: "conversation", bindingId: "fresh" },
                async () => {
                  runCalls += 1;
                },
                {
                  authority: resolved.authority,
                },
              ),
            ).rejects.toThrow("Codex session generation is no longer current");
          } finally {
            resolved.release();
          }

          expect(runCalls).toBe(0);
          expect(deleteAttempts.count).toBe(1);
          expect(syncBindingStore.lookup("session:main:abandoned")).toBeDefined();
        },
        {
          mutateLineageAtDelete: async () => {
            await applySessionEntryPatch({
              ...read,
              patch: {
                sessionId: "real-session",
                previousSessionId: "changed-predecessor",
                updatedAt: 2,
              },
            });
          },
        },
      );
    });
  });
});
