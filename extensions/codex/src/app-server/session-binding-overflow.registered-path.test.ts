import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
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
// The registered plugin assembles its recovery adapter and worker-backed stores.
// Test SDK openers clamp capacity and resolve fixture operations, without a shipped
// Gateway. A dispatch hook controls the real session-change interleaving.
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

type DeleteAttempts = {
  count: number;
  dispatched: number;
  mutationsCompleted: number;
  dispatchFailure?: unknown;
};

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
    deleteAttempts: DeleteAttempts;
  }) => Promise<void>,
  options?: {
    mutateLineageAfterAdmission?: () => void | Promise<void>;
  },
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-binding-entry-"));
  const deleteAttempts: DeleteAttempts = { count: 0, dispatched: 0, mutationsCompleted: 0 };
  const dispatch = vi.spyOn(Worker.prototype, "postMessage");
  Worker.prototype.postMessage = function (this: Worker, message, transferList) {
    const mutate = options?.mutateLineageAfterAdmission;
    if (mutate && message?.type === "execute" && message.input instanceof Uint8Array) {
      const command: unknown = deserialize(message.input);
      if (
        command &&
        typeof command === "object" &&
        "type" in command &&
        command.type === "pluginState.compareDelete"
      ) {
        // The broker admitted this command; change lineage before its worker receives it.
        void Promise.resolve()
          .then(mutate)
          .then(() => {
            deleteAttempts.mutationsCompleted += 1;
          })
          .catch((error: unknown) => {
            deleteAttempts.dispatchFailure = error;
          })
          .then(() => {
            dispatch.call(this, message, transferList);
            deleteAttempts.dispatched += 1;
          })
          .catch((error: unknown) => {
            deleteAttempts.dispatchFailure = error;
          });
        return;
      }
    }
    dispatch.call(this, message, transferList);
  };
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
          const store = createPluginStateKeyedStoreV2ForTests<T>(
            "codex",
            withFixtureEnv(clampBindingCapacity(storeOptions)),
            {
              assertCurrent: () => authority?.assertCurrent(),
              sessionEntryCurrent: authority?.sessionEntryCurrent,
            },
          );
          if (
            storeOptions?.namespace === CODEX_APP_SERVER_BINDING_NAMESPACE &&
            options?.mutateLineageAfterAdmission
          ) {
            if (authority) {
              const compareAndApply = store.compareAndApply?.bind(store);
              if (compareAndApply) {
                store.compareAndApply = async (key, comparison, intent, compareOptions) => {
                  if (intent.operation === "delete") {
                    deleteAttempts.count += 1;
                  }
                  return await compareAndApply(key, comparison, intent, compareOptions);
                };
              }
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
      deleteAttempts,
    });
  } finally {
    dispatch.mockRestore();
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

  it.each([
    { change: "lineage", sessionId: "real-session", previousSessionId: "changed-predecessor" },
    { change: "reset", sessionId: "replacement-session", previousSessionId: "real-session" },
  ])(
    "rejects a queued delete after a real session $change",
    async ({ sessionId, previousSessionId }) => {
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
            let failure: unknown;
            const prepared = await resolved.authority.prepareMutation();
            expect(prepared.sessionEntryCurrent).toBeDefined();
            try {
              await bindingStore.withLease(
                { kind: "conversation", bindingId: "fresh" },
                async () => {
                  runCalls += 1;
                },
                { authority: resolved.authority },
              );
            } catch (error) {
              failure = error;
            } finally {
              resolved.release();
            }

            expect(runCalls).toBe(0);
            expect(syncBindingStore.lookup("session:main:abandoned")).toBeDefined();
            expect(deleteAttempts).toMatchObject({
              count: 1,
              dispatched: 1,
              mutationsCompleted: 1,
            });
            expect(deleteAttempts.dispatchFailure).toBeUndefined();
            expect(failure).toMatchObject({
              code: "PLUGIN_STATE_WRITE_FAILED",
              operation: "delete",
              cause: expect.objectContaining({
                message: "Codex session generation is no longer current: real-session",
              }),
            });
          },
          {
            mutateLineageAfterAdmission: async () => {
              await applySessionEntryPatch({
                ...read,
                patch: {
                  sessionId,
                  previousSessionId,
                  updatedAt: 2,
                },
              });
            },
          },
        );
      });
    },
  );
});
