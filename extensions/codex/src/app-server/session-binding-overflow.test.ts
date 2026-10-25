// Codex tests cover binding-state capacity recovery at namespace overflow.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  withCodexBindingOverflowRecovery,
  type CodexBindingOverflowRecoveryBounds,
} from "./session-binding-overflow.js";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  type CodexAppServerBindingStore,
  type CodexBindingAuthority,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";

function createRecoveringBindingStore(
  namespace: string,
  maxEntries: number,
  stateDir: string,
  bounds?: Partial<CodexBindingOverflowRecoveryBounds>,
) {
  const options = {
    namespace,
    maxEntries,
    overflowPolicy: "reject-new" as const,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  const state = createCodexSqliteTestBindingStateStore(options);
  // Same composition the production lazy binding store installs: sync handle
  // for hot reads, worker-backed handle for recovery listing and deletion.
  const recoveryState = createPluginStateKeyedStoreForTests<StoredCodexAppServerBinding>(
    "codex",
    options,
  );
  const store = withCodexBindingOverflowRecovery(
    createCodexAppServerBindingStore(state),
    recoveryState,
    bounds,
  );
  return { state, store };
}

function createOverflowStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-overflow-"));
}

// Recovery sheds rows only under caller authority; tests that exercise the
// sweep pass this no-op liveness closure as the caller's assertCurrent.
const assertCallerPresent = () => {};

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding overflow recovery", () => {
  it("evicts an abandoned cleared row before any live binding when the namespace overflows", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-cleared-test",
        2,
        stateDir,
      );
      const live = { kind: "conversation" as const, bindingId: "live" };
      // The live row is the oldest entry: age-only eviction would drop it first.
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).resolves.toBe(true);

      expect(state.lookup("session:main:abandoned")).toBeUndefined();
      expect(store.read(live)).toMatchObject({ threadId: "thread-live" });
      expect(store.read(incoming)).toMatchObject({ threadId: "thread-incoming" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("sheds nothing for a caller carrying no authority, even with a disposable row", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-no-authority-test",
        2,
        stateDir,
      );
      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      // Bare caller: no assertCurrent, no authority. Plugin-runtime liveness
      // alone does not authorize deleting a shared row for this caller, so
      // the sweep sheds nothing and the row-limit error propagates.
      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(incoming, {
          kind: "set",
          binding: { threadId: "thread-incoming", cwd: "/repo" },
        }),
      ).rejects.toThrow(/reached its 2-row limit/);
      expect(state.lookup("session:main:abandoned")).toBeDefined();
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the namespace holds only authority fences and live bindings", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-fence-test",
        2,
        stateDir,
      );
      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      const retiredIdentity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-retired",
        sessionKey: "agent:main:telegram:chat-retired",
      };
      await store.mutate(retiredIdentity, {
        kind: "set",
        binding: { threadId: "thread-retired", cwd: "/repo" },
      });
      await expect(store.retireSessionGeneration(retiredIdentity)).resolves.toBe("applied");

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).rejects.toThrow(/reached its 2-row limit/);

      expect(state.lookup(bindingStoreKey(retiredIdentity))).toMatchObject({
        state: "cleared",
        retired: true,
      });
      expect(store.read(live)).toMatchObject({ threadId: "thread-live" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("never evicts a row whose lease is still live", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-lease-test",
        2,
        stateDir,
      );
      const liveLease = { token: "token-a", expiresAt: Date.now() + 60_000 };
      state.register("conversation:leased-active", {
        version: 1,
        state: "active",
        binding: { threadId: "thread-leased", cwd: "/repo" },
        lease: liveLease,
      });
      state.register("conversation:leased-cleared", {
        version: 1,
        state: "cleared",
        lease: { token: "token-b", expiresAt: Date.now() + 60_000 },
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).rejects.toThrow(/reached its 2-row limit/);

      expect(state.lookup("conversation:leased-active")).toMatchObject({ lease: liveLease });
      expect(state.lookup("conversation:leased-cleared")).toMatchObject({ state: "cleared" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("never evicts retained legacy-clear provenance during capacity recovery", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-legacy-test",
        2,
        stateDir,
      );
      const legacy = { kind: "conversation" as const, bindingId: "legacy-source" };
      await store.mutate(legacy, {
        kind: "set",
        binding: { threadId: "thread-legacy", cwd: "/repo" },
      });
      await store.mutate(legacy, { kind: "clear" });
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).resolves.toBe(true);

      expect(state.lookup("session:main:abandoned")).toBeUndefined();
      expect(state.lookup(bindingStoreKey(legacy))).toMatchObject({ state: "cleared" });
      expect(store.read(incoming)).toMatchObject({ threadId: "thread-incoming" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("sheds only the strictly valid disposable row and preserves ambiguous existing state", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-ambiguous-test",
        2,
        stateDir,
      );
      // Pre-existing state written by an older or damaged build: a cleared
      // row with a lease that is not even an object must never become
      // "apparently unprotected" and get deleted.
      state.register("conversation:ambiguous-lease", {
        version: 1,
        state: "cleared",
        lease: "not-a-lease",
      } as unknown as StoredCodexAppServerBinding);
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).resolves.toBe(true);

      expect(state.lookup("session:main:abandoned")).toBeUndefined();
      expect(state.lookup("conversation:ambiguous-lease")).toMatchObject({
        lease: "not-a-lease",
      });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when every candidate's raw protection fields are ambiguous", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-rawguard-test",
        2,
        stateDir,
      );
      state.register("conversation:lease-wrong-type", {
        version: 1,
        state: "cleared",
        lease: { token: 42, expiresAt: "soon" },
      } as unknown as StoredCodexAppServerBinding);
      state.register("conversation:retired-marker-other", {
        version: 1,
        state: "cleared",
        retired: "yes",
      } as unknown as StoredCodexAppServerBinding);

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).rejects.toThrow(/reached its 2-row limit/);

      expect(state.lookup("conversation:lease-wrong-type")).toMatchObject({
        state: "cleared",
      });
      expect(state.lookup("conversation:retired-marker-other")).toMatchObject({
        state: "cleared",
      });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps cleared rows that carry a task-import receipt when the namespace overflows", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-receipt-test",
        2,
        stateDir,
      );
      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      // Clear, reset, and lease release deliberately retain this marker
      // without expiry so Doctor never re-imports a handled legacy task;
      // recovery must keep the row even when it is the only candidate.
      state.register("session:main:imported", {
        version: 1,
        state: "cleared",
        sessionId: "imported-session",
        nativeSubagentTaskImport: { version: 1, taskIds: ["legacy-running"] },
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).rejects.toThrow(/reached its 2-row limit/);

      expect(state.lookup("session:main:imported")).toMatchObject({
        nativeSubagentTaskImport: { version: 1, taskIds: ["legacy-running"] },
      });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("carries full session authority into the retried insert and the recovery delete", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const options = {
        namespace: "app-server-thread-bindings-overflow-authority-forward-test",
        maxEntries: 2,
        overflowPolicy: "reject-new" as const,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      const state = createCodexSqliteTestBindingStateStore(options);
      const base = createCodexAppServerBindingStore(state);
      const mutateAuthorities: unknown[] = [];
      const recordingBase: CodexAppServerBindingStore = {
        ...base,
        mutate: (identity, mutation, assertCurrent, authority) => {
          mutateAuthorities.push(authority);
          return base.mutate(identity, mutation, assertCurrent, authority);
        },
      };
      const baseRecovery = createPluginStateKeyedStoreForTests<StoredCodexAppServerBinding>(
        "codex",
        options,
      );
      let withCurrentArg: unknown;
      const recovery = {
        entriesInKeyRange: baseRecovery.entriesInKeyRange?.bind(baseRecovery),
        compareAndApply: baseRecovery.compareAndApply?.bind(baseRecovery),
        observe: baseRecovery.observe?.bind(baseRecovery),
        withCurrent: (
          writerAuthority: Parameters<NonNullable<typeof baseRecovery.withCurrent>>[0],
        ) => {
          withCurrentArg = writerAuthority;
          return baseRecovery.withCurrent!(writerAuthority);
        },
      };
      const store = withCodexBindingOverflowRecovery(recordingBase, recovery);

      // The wrapper only reads prepareMutation off the authority; a minimal
      // stand-in pins exactly what the recovery delete forwards.
      const sessionEntryCurrent = { sources: [], assertCurrent: () => {} };
      let prepareCalls = 0;
      const authority = {
        prepareMutation: async () => {
          prepareCalls += 1;
          return { assertCurrent: () => {}, sessionEntryCurrent };
        },
      } as unknown as CodexBindingAuthority;
      const assertCurrent = () => {};

      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(
        live,
        { kind: "set", binding: { threadId: "thread-live", cwd: "/repo" } },
        assertCurrent,
        authority,
      );
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          { kind: "set", binding: { threadId: "thread-incoming", cwd: "/repo" } },
          assertCurrent,
          authority,
        ),
      ).resolves.toBe(true);

      // Every attempt, not just the first, forwards the caller's authority.
      expect(mutateAuthorities).toHaveLength(3);
      expect(mutateAuthorities.every((a) => a === authority)).toBe(true);
      // The lifecycle prepares the authority once per mutation attempt and
      // the sweep prepares it once more for its delete: exactly one prepare
      // beyond the mutate count proves both paths carry it.
      expect(prepareCalls).toBe(mutateAuthorities.length + 1);
      const writerAuthority = withCurrentArg as {
        assertCurrent?: unknown;
        sessionEntryCurrent?: unknown;
      };
      expect(typeof writerAuthority.assertCurrent).toBe("function");
      expect(writerAuthority.sessionEntryCurrent).toBe(sessionEntryCurrent);
      expect(state.lookup("session:main:abandoned")).toBeUndefined();
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers a fresh session's lease admission when the namespace is full", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-lease-test",
        2,
        stateDir,
      );
      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      // A fresh session acquires its lease before any mutate; the lease
      // insert itself overflows, so recovery must fire at admission.
      let runCalls = 0;
      const result = await store.withLease(
        { kind: "conversation", bindingId: "fresh" },
        async () => {
          runCalls += 1;
          return "started";
        },
        { assertCurrent: assertCallerPresent },
      );
      expect(result).toBe("started");
      expect(runCalls).toBe(1);
      expect(state.lookup("session:main:abandoned")).toBeUndefined();
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("never re-runs the lease callback when a row-limit error escapes from inside it", async () => {
    const stateDir = createOverflowStateDir();
    try {
      // One free row: acquisition succeeds without a sweep, so anything the
      // sweep touches after `run` starts shows up on the disposable row.
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-lease-no-retry-test",
        3,
        stateDir,
      );
      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      // A row-limit-shaped failure raised by the caller's own work is not an
      // acquisition failure: retrying would double-start the session.
      const inner = Object.assign(new Error("namespace codex.bindings reached its 3-row limit"), {
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
      let runCalls = 0;
      await expect(
        store.withLease({ kind: "conversation", bindingId: "fresh" }, async () => {
          runCalls += 1;
          throw inner;
        }),
      ).rejects.toBe(inner);
      expect(runCalls).toBe(1);
      // No recovery ran for a post-acquisition failure: the disposable row
      // survives and no second acquisition was attempted.
      expect(state.lookup("session:main:abandoned")).toBeDefined();
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers through the production lazy binding store composition", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const options = {
        namespace: "app-server-thread-bindings-overflow-lazy-test",
        maxEntries: 2,
        overflowPolicy: "reject-new" as const,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      const state = createCodexSqliteTestBindingStateStore(options);
      const recoveryState = createPluginStateKeyedStoreForTests<StoredCodexAppServerBinding>(
        "codex",
        options,
      );
      const store = createLazyCodexAppServerBindingStore(state, undefined, recoveryState);
      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).resolves.toBe(true);

      expect(state.lookup("session:main:abandoned")).toBeUndefined();
      expect(store.read(live)).toMatchObject({ threadId: "thread-live" });
      expect(store.read(incoming)).toMatchObject({ threadId: "thread-incoming" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("never deletes after the caller loses authority mid-recovery", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const options = {
        namespace: "app-server-thread-bindings-overflow-authority-test",
        maxEntries: 2,
        overflowPolicy: "reject-new" as const,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      const state = createCodexSqliteTestBindingStateStore(options);
      const baseRecovery = createPluginStateKeyedStoreForTests<StoredCodexAppServerBinding>(
        "codex",
        options,
      );
      // The caller is revoked while the recovery's awaited observe is in
      // flight: exactly the window between the failed insert and the delete.
      let revoked = false;
      const recovery = {
        entriesInKeyRange: baseRecovery.entriesInKeyRange?.bind(baseRecovery),
        compareAndApply: baseRecovery.compareAndApply?.bind(baseRecovery),
        observe: async (key: string) => {
          const observation = await baseRecovery.observe!(key);
          revoked = true;
          return observation;
        },
        withCurrent: baseRecovery.withCurrent?.bind(baseRecovery),
      };
      const store = withCodexBindingOverflowRecovery(
        createCodexAppServerBindingStore(state),
        recovery,
      );
      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          { kind: "set", binding: { threadId: "thread-incoming", cwd: "/repo" } },
          () => {
            if (revoked) {
              throw new Error("caller authority revoked");
            }
          },
        ),
      ).rejects.toThrow(/authority revoked/);

      // The revoked caller triggered zero deletes: the disposable row survives.
      expect(state.lookup("session:main:abandoned")).toMatchObject({ state: "cleared" });
      expect(store.read(live)).toMatchObject({ threadId: "thread-live" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
  it("never lets a queued delete land after the caller loses authority at write admission", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const options = {
        namespace: "app-server-thread-bindings-overflow-admission-test",
        maxEntries: 2,
        overflowPolicy: "reject-new" as const,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      const state = createCodexSqliteTestBindingStateStore(options);
      const baseRecovery = createPluginStateKeyedStoreForTests<StoredCodexAppServerBinding>(
        "codex",
        options,
      );
      // The caller stays authorized through the failed insert, the sweep, and
      // the local pre-dispatch assertion; revocation lands only when the
      // delete reaches the worker, and the worker's admission must recheck it.
      let revoked = false;
      const recovery = {
        entriesInKeyRange: baseRecovery.entriesInKeyRange?.bind(baseRecovery),
        compareAndApply: baseRecovery.compareAndApply?.bind(baseRecovery),
        observe: baseRecovery.observe?.bind(baseRecovery),
        withCurrent: (authority: { assertCurrent: () => void }) => {
          const bound = baseRecovery.withCurrent!(authority);
          return {
            ...bound,
            compareAndApply: (...args: Parameters<NonNullable<typeof bound.compareAndApply>>) => {
              revoked = true;
              return bound.compareAndApply(...args);
            },
          };
        },
      };
      const store = withCodexBindingOverflowRecovery(
        createCodexAppServerBindingStore(state),
        recovery,
      );
      const live = { kind: "conversation" as const, bindingId: "live" };
      await store.mutate(live, {
        kind: "set",
        binding: { threadId: "thread-live", cwd: "/repo" },
      });
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          { kind: "set", binding: { threadId: "thread-incoming", cwd: "/repo" } },
          () => {
            if (revoked) {
              throw new Error("caller authority revoked");
            }
          },
        ),
      ).rejects.toThrow(/authority revoked/);

      // The delete was admitted after revocation, so nothing was deleted.
      expect(state.lookup("session:main:abandoned")).toMatchObject({ state: "cleared" });
      expect(store.read(live)).toMatchObject({ threadId: "thread-live" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("resumes the scan where the previous failure stopped, across inserts", async () => {
    const stateDir = createOverflowStateDir();
    try {
      // One page of four per failure and a single retry: the first insert
      // stalls mid-prefix, and only a persisted scan position lets the second
      // insert reach the abandoned row behind it.
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-resume-test",
        7,
        stateDir,
        { evictionAttempts: 1, pageLimit: 4, pagesPerCall: 1 },
      );
      for (let i = 0; i < 6; i++) {
        state.register(`conversation:leased-${i}`, {
          version: 1,
          state: "cleared",
          lease: { token: "owner-token", expiresAt: Date.now() + 600_000 },
        });
      }
      state.register("session:main:abandoned", {
        version: 1,
        state: "cleared",
        sessionId: "abandoned-session",
      });

      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).rejects.toThrow(/reached its 7-row limit/);
      expect(state.lookup("session:main:abandoned")).toMatchObject({ state: "cleared" });

      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).resolves.toBe(true);
      expect(state.lookup("session:main:abandoned")).toBeUndefined();
      for (let i = 0; i < 6; i++) {
        expect(state.lookup(`conversation:leased-${i}`)).toMatchObject({ state: "cleared" });
      }
      expect(store.read(incoming)).toMatchObject({ threadId: "thread-incoming" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reconsiders rows whose leases lapse after a fully protected pass", async () => {
    const stateDir = createOverflowStateDir();
    try {
      const { state, store } = createRecoveringBindingStore(
        "app-server-thread-bindings-overflow-lapse-test",
        2,
        stateDir,
      );
      const liveLease = () => ({ token: "owner-token", expiresAt: Date.now() + 60_000 });
      state.register("conversation:leased-a", {
        version: 1,
        state: "cleared",
        lease: liveLease(),
      });
      state.register("conversation:leased-b", {
        version: 1,
        state: "cleared",
        lease: liveLease(),
      });

      // Every row is protected, so the first pass scans the whole namespace
      // and the insert still fails.
      const incoming = { kind: "conversation" as const, bindingId: "incoming" };
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).rejects.toThrow(/reached its 2-row limit/);

      // Once the leases lapse, a fresh pass must reconsider those rows instead
      // of staying parked past the end of the namespace.
      state.register("conversation:leased-a", {
        version: 1,
        state: "cleared",
        lease: { token: "owner-token", expiresAt: Date.now() - 1_000 },
      });
      await expect(
        store.mutate(
          incoming,
          {
            kind: "set",
            binding: { threadId: "thread-incoming", cwd: "/repo" },
          },
          assertCallerPresent,
        ),
      ).resolves.toBe(true);
      expect(store.read(incoming)).toMatchObject({ threadId: "thread-incoming" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
