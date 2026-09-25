// Codex tests cover the SQLite-backed thread binding facade.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  getSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerThreadBinding,
  reclaimCurrentCodexSessionGeneration,
  resolveCodexSessionBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

function createStateStore() {
  const values = new Map<string, StoredCodexAppServerBinding>();
  const state: PluginStateSyncKeyedStore<StoredCodexAppServerBinding> = {
    register(key, value) {
      values.set(key, value);
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (!next) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    lookup: (key) => values.get(key),
    consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    deleteIf: (key, predicate) => {
      const value = values.get(key);
      return value !== undefined && predicate(value) && values.delete(key);
    },
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    clear: () => values.clear(),
  };
  return { state, values };
}

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding store", () => {
  it("rechecks resume authority after the lazy store resolves and before writing", async () => {
    const { state } = createStateStore();
    const store = createLazyCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "pending-resume" };
    const binding = {
      threadId: "thread-pending",
      cwd: "/repo",
      pendingResumeConfiguration: true as const,
    };
    await store.mutate(identity, { kind: "set", binding });
    let current = true;
    const writing = store.mutate(
      identity,
      {
        kind: "patch",
        threadId: binding.threadId,
        patch: { pendingResumeConfiguration: undefined },
      },
      () => {
        if (!current) {
          throw new Error("resume authority changed");
        }
      },
    );
    current = false;
    await expect(writing).rejects.toThrow("resume authority changed");
    expect(store.read(identity)).toEqual(binding);
  });

  it("deletes only the requested stable owner in SQLite", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-binding-delete-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "deletion-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
      });
      const store = createCodexAppServerBindingStore(state);
      const base = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "shared-id",
        sessionKey: "agent:main:cron:job",
      };
      const run = { ...base, sessionKey: `${base.sessionKey}:run:one` };
      for (const identity of [base, run]) {
        await store.mutate(identity, {
          kind: "set",
          binding: {
            threadId: identity.sessionKey,
            cwd: "/repo",
          },
        });
      }
      await store.withSessionDeletion(
        run,
        () => {},
        async (_binding, mutation) => {
          mutation.commit();
          expect(state.lookup(bindingStoreKey(run))).toBeUndefined();
          expect(state.lookup(bindingStoreKey(base))).toMatchObject({ state: "active" });
        },
      );
      expect(state.entries().map(({ key }) => key)).toEqual([bindingStoreKey(base)]);
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes retired fences without creating rows for absent bindings", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "old",
      sessionKey: "agent:main:cron:expired",
    };
    await store.mutate(identity, { kind: "set", binding: { threadId: "old", cwd: "/repo" } });
    await store.retireSessionGeneration(identity);
    for (let attempt = 0; attempt < 2; attempt++) {
      await store.withSessionDeletion(
        identity,
        () => {},
        async (binding, mutation) => {
          expect(binding).toBeUndefined();
          mutation.commit();
        },
      );
      expect(values.size).toBe(0);
    }
  });

  it("rejects deletion by a stale stable generation", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "old",
      sessionKey: "agent:main:cron:expired",
    };
    const successor = {
      version: 1 as const,
      state: "active" as const,
      sessionId: "new",
      binding: { threadId: "new", cwd: "/repo" },
    };
    state.register(bindingStoreKey(identity), successor);
    await expect(
      store.withSessionDeletion(
        identity,
        () => {},
        async (_binding, mutation) => {
          mutation.commit();
        },
      ),
    ).rejects.toThrow("generation changed");
    expect(values.get(bindingStoreKey(identity))).toEqual(successor);
  });

  it("stores domain data under the canonical session identity", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo", model: "gpt-5.4-codex" },
    });

    const binding = store.read(identity);
    expect(binding).toMatchObject({ threadId: "thread-1", cwd: "/repo" });
    expect(binding).not.toHaveProperty("sessionFile");
    expect(binding).not.toHaveProperty("schemaVersion");
    expect(values.get("session:main:session-1")).toMatchObject({
      version: 1,
      state: "active",
      binding: { threadId: "thread-1" },
    });
  });

  it("replaces only the exact ordinary thread owner", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-cas" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-stale",
        binding: { threadId: "thread-new", cwd: "/repo" },
      }),
    ).resolves.toBe(false);
    expect(store.read(identity)).toMatchObject({ threadId: "thread-old" });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: { threadId: "thread-new", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    expect(store.read(identity)).toMatchObject({ threadId: "thread-new" });
  });

  it("rejects same-thread and supervision ownership through replacement CAS", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-cas-boundary",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: { threadId: "thread-old", cwd: "/repo" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: {
          threadId: "thread-private",
          cwd: "/repo",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-private",
          preserveNativeModel: true,
        },
      }),
    ).resolves.toBe(false);
    expect(store.read(identity)).toMatchObject({ threadId: "thread-old" });
  });

  it("does not report the exact session or conversation binding owner as another owner", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const sessionIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await store.mutate(sessionIdentity, {
      kind: "set",
      binding: { threadId: "thread-session", cwd: "/repo" },
    });

    await expect(store.hasOtherThreadOwner("thread-session", sessionIdentity)).resolves.toBe(false);

    const conversationIdentity = { kind: "conversation" as const, bindingId: "conversation-1" };
    await store.mutate(conversationIdentity, {
      kind: "set",
      binding: { threadId: "thread-conversation", cwd: "/repo" },
    });
    await expect(
      store.hasOtherThreadOwner("thread-conversation", conversationIdentity),
    ).resolves.toBe(false);
  });

  it("reports a different valid active binding owner", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await store.mutate(
      { kind: "conversation", bindingId: "conversation-owner" },
      {
        kind: "set",
        binding: { threadId: "thread-owned", cwd: "/repo" },
      },
    );

    await expect(store.hasOtherThreadOwner("thread-owned", currentIdentity)).resolves.toBe(true);
  });

  it.each([
    { name: "a different generation", storedSessionId: "session-previous" },
    { name: "a missing generation", storedSessionId: undefined },
  ])("treats $name under the same stable key as another owner", async ({ storedSessionId }) => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:stable",
    };
    values.set(bindingStoreKey(currentIdentity), {
      version: 1,
      state: "active",
      binding: { threadId: "thread-stale-generation", cwd: "/repo" },
      ...(storedSessionId ? { sessionId: storedSessionId } : {}),
    });

    await expect(
      store.hasOtherThreadOwner("thread-stale-generation", currentIdentity),
    ).resolves.toBe(true);
  });

  it("fails closed on a malformed row during reverse ownership scans", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    values.set("conversation:invalid", {
      version: 1,
      state: "active",
      binding: { threadId: "", cwd: "/repo" },
    } as never);

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).rejects.toThrow(
      "Invalid Codex app-server binding row: conversation:invalid",
    );
  });

  it("ignores stale cleared rows during reverse ownership scans", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    values.set("conversation:cleared", {
      version: 1,
      state: "cleared",
      retired: true,
      binding: { threadId: "thread-unowned", cwd: "/repo" },
    } as never);

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).resolves.toBe(false);
  });

  it("fails closed on malformed pending supervision state", async () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-source",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-source",
          cleanupThreadIds: ["thread-probe", "thread-probe"],
        },
      }),
    ).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-other",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: { sourceThreadId: "thread-source" },
      }),
    ).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-source",
        cwd: "/repo",
        pendingSupervisionBranch: { sourceThreadId: "thread-source", unknown: true },
      }),
    ).toBeUndefined();

    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-corrupt",
    };
    state.register(bindingStoreKey(identity), {
      version: 1,
      state: "active",
      binding: {
        threadId: "thread-source",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-source",
          cleanupThreadIds: ["thread-source"],
        },
      },
    } as never);

    expect(() => store.read(identity)).toThrow("Invalid Codex app-server binding row");
  });

  it("fails closed on malformed private supervision ownership", () => {
    const valid = {
      threadId: "thread-source",
      cwd: "/repo",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-source" },
    };

    expect(readCodexAppServerThreadBinding({ ...valid, connectionScope: "user" })).toBeUndefined();
    expect(readCodexAppServerThreadBinding({ ...valid, connectionScope: {} })).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({ ...valid, supervisionSourceThreadId: undefined }),
    ).toBeUndefined();
  });

  it("commits a pending supervision branch only from its exact cleanup snapshot", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-supervision-cas",
    };
    const initial = {
      sourceThreadId: "thread-source",
      connectionFingerprint: "connection-one",
      lastTurnId: "turn-terminal",
    };
    await expect(
      store.mutate(identity, {
        kind: "set",
        if: { kind: "absent" },
        binding: {
          threadId: "thread-source",
          cwd: "/repo",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-source",
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          pendingSupervisionBranch: initial,
        },
      }),
    ).resolves.toBe(true);
    const tracked = { ...initial, cleanupThreadIds: ["thread-probe"] };
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: { ...initial, connectionFingerprint: "connection-two" },
        pending: tracked,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: { ...initial, lastTurnId: "turn-other" },
        pending: tracked,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: initial,
        pending: tracked,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: initial,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: tracked,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      }),
    ).resolves.toBe(true);
    expect(store.read(identity)).toEqual({
      threadId: "thread-final",
      cwd: "/repo",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      model: "native-model",
      modelProvider: "native-provider",
    });
  });

  it("round-trips account app policy context", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-account" };
    const pluginAppPolicyContext = {
      fingerprint: "account-policy-1",
      apps: {
        "chatgpt-meetings": {
          source: "account" as const,
          appName: "ChatGPT Meetings",
          allowDestructiveActions: true,
          allowOpenWorld: false,
          destructiveApprovalMode: "auto" as const,
          mcpServerNames: [],
        },
      },
      pluginAppIds: {},
    };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-account", cwd: "/repo", pluginAppPolicyContext },
    });
    expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-account",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("round-trips repository marketplace app ownership through stored and imported bindings", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-security-review",
    };
    const pluginAppPolicyContext = {
      fingerprint: "repository-plugin-policy",
      apps: {
        github: {
          configKey: "security-review@company-tools",
          marketplaceName: "company-tools",
          pluginName: "security-review",
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask" as const,
          mcpServerNames: ["github"],
        },
      },
      pluginAppIds: { "security-review@company-tools": ["github"] },
    };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-security-review", cwd: "/repo/company", pluginAppPolicyContext },
    });
    expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-security-review",
      cwd: "/repo/company",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("keeps a replacement thread when a stale clear completes later", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });

    await expect(store.mutate(identity, { kind: "clear", threadId: "thread-old" })).resolves.toBe(
      false,
    );
    expect(store.read(identity)).toMatchObject({ threadId: "thread-new" });
    await expect(store.mutate(identity, { kind: "clear", threadId: "thread-new" })).resolves.toBe(
      true,
    );
    expect(store.read(identity)).toBeUndefined();
  });

  it("retains cleared legacy conversation provenance after normal tombstones expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "app-server-thread-bindings-clear-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const normal = { kind: "conversation" as const, bindingId: "normal" };
      const legacy = { kind: "conversation" as const, bindingId: "legacy-source" };
      for (const identity of [normal, legacy]) {
        await store.mutate(identity, {
          kind: "set",
          binding: { threadId: `thread-${identity.bindingId}`, cwd: "/repo" },
        });
        await store.mutate(identity, { kind: "clear" });
      }

      vi.advanceTimersByTime(10);
      expect(state.lookup(bindingStoreKey(normal))).toBeUndefined();
      expect(state.lookup(bindingStoreKey(legacy))).toEqual({ version: 1, state: "cleared" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("isolates identical session ids owned by different agents", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = { kind: "session" as const, agentId: "first", sessionId: "shared" };
    const second = { kind: "session" as const, agentId: "second", sessionId: "shared" };

    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-first", cwd: "/first" },
    });
    await store.mutate(second, {
      kind: "set",
      binding: { threadId: "thread-second", cwd: "/second" },
    });

    expect(store.read(first)).toMatchObject({ threadId: "thread-first" });
    expect(store.read(second)).toMatchObject({ threadId: "thread-second" });
    expect(bindingStoreKey({ kind: "session", agentId: " First ", sessionId: "shared" })).toBe(
      "session:first:shared",
    );
  });

  it("keeps one binding across physical session rotations for a stable session key", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };

    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    expect(store.read(second)).toBeUndefined();
    await store.withLease(second, async () => undefined);

    expect(bindingStoreKey(first)).toBe(bindingStoreKey(second));
    expect(values.size).toBe(1);
    expect(values.get(bindingStoreKey(second))).toMatchObject({ sessionId: "session-1" });
    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
    expect(values.get(bindingStoreKey(second))).toMatchObject({
      state: "active",
      sessionId: "session-2",
      binding: { threadId: "thread-1" },
    });
    await expect(
      store.mutate(first, {
        kind: "patch",
        threadId: "thread-1",
        patch: { model: "stale-model" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(first, { kind: "clear" })).resolves.toBe(false);
    expect(store.read(second)).toMatchObject({ threadId: "thread-1" });
    await expect(store.mutate(second, { kind: "clear" })).resolves.toBe(true);
  });

  it("rejects a delayed adoption after a newer session generation wins", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });

    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
    await expect(store.adoptSessionGeneration(third, second.sessionId)).resolves.toBe("adopted");
    await expect(store.adoptSessionGeneration(third, second.sessionId)).resolves.toBe("current");
    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("conflict");
    await expect(store.retireSessionGeneration(second)).resolves.toBe("conflict");

    expect(store.read(second)).toBeUndefined();
    expect(store.read(third)).toMatchObject({ threadId: "thread-1" });
  });

  it.each(["ordinary", "supervision"] as const)(
    "adopts the committed predecessor after reopening a %s binding without a compaction hook",
    async (ownership) => {
      const fixture = await createOpenClawTestState({
        prefix: "codex-predecessor-reopen-",
        layout: "state-only",
        applyEnv: false,
      });
      const root = fixture.stateDir;
      const storePath = path.join(root, "sessions.json");
      const previous = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-before-compaction",
        sessionKey: "agent:main:compaction",
      };
      const current = { ...previous, sessionId: "session-after-compaction" };
      const sessionScope = { agentId: current.agentId, sessionKey: current.sessionKey, storePath };
      const binding = {
        threadId: "native-thread-before-compaction",
        cwd: "/repo",
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint("native-tools"),
        ...(ownership === "supervision"
          ? {
              connectionScope: "supervision" as const,
              supervisionSourceThreadId: "native-source",
              conversationSourceTransferComplete: true as const,
              preserveNativeModel: true as const,
            }
          : {}),
      };
      const openStore = () => {
        const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>(
          "codex",
          {
            namespace: "predecessor-reopen",
            maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
            overflowPolicy: "reject-new",
            env: { ...process.env, OPENCLAW_STATE_DIR: root },
          },
        );
        return { state, store: createLazyCodexAppServerBindingStore(state) };
      };
      try {
        await upsertSessionEntry({
          ...sessionScope,
          entry: { sessionId: previous.sessionId, updatedAt: 1 },
        });
        await openStore().store.mutate(previous, { kind: "set", binding });
        await patchSessionEntry({
          ...sessionScope,
          update: () => ({ sessionId: current.sessionId }),
        });
        expect(getSessionEntry(sessionScope)).toMatchObject({
          sessionId: current.sessionId,
          previousSessionId: previous.sessionId,
        });
        resetPluginStateStoreForTests();
        const { state, store } = openStore();
        expect(store.read(current)).toBeUndefined();

        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(
            reclaimCurrentCodexSessionGeneration({
              bindingStore: store,
              identity: current,
              storePath,
            }),
          ).resolves.toBe(true);
          expect(store.read(current)).toEqual(binding);
        }
        expect(state.lookup(bindingStoreKey(current))).toEqual({
          version: 1,
          state: "active",
          sessionId: current.sessionId,
          binding,
        });
        await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
      } finally {
        resetPluginStateStoreForTests();
        await fixture.cleanup();
      }
    },
  );

  it.each(
    ["two generations behind", "different session key", "different agent"].flatMap((mismatch) =>
      [false, true].map((supervision) => ({ mismatch, supervision })),
    ),
  )(
    "does not adopt a binding owned by $mismatch (supervision=$supervision)",
    async ({ mismatch, supervision }) => {
      const fixture = await createOpenClawTestState({
        prefix: "codex-predecessor-mismatch-",
        layout: "state-only",
        applyEnv: false,
      });
      const root = fixture.stateDir;
      const storePath = path.join(root, "sessions.json");
      const { state } = createStateStore();
      const store = createCodexAppServerBindingStore(state);
      const current = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-current",
        sessionKey: "agent:main:compaction",
      };
      const previous = {
        ...current,
        sessionId: mismatch === "two generations behind" ? "session-oldest" : "session-previous",
        ...(mismatch === "different session key" ? { sessionKey: "agent:main:other" } : {}),
        ...(mismatch === "different agent" ? { agentId: "other" } : {}),
      };
      const binding = {
        threadId: "native-thread-foreign-generation",
        cwd: "/repo",
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        ...(supervision
          ? {
              connectionScope: "supervision" as const,
              supervisionSourceThreadId: "native-source",
              conversationSourceTransferComplete: true as const,
              preserveNativeModel: true as const,
            }
          : {}),
      };
      try {
        await upsertSessionEntry({
          agentId: current.agentId,
          sessionKey: current.sessionKey,
          storePath,
          entry: {
            sessionId: current.sessionId,
            previousSessionId: "session-previous",
            updatedAt: 1,
          },
        });
        await store.mutate(previous, { kind: "set", binding });

        await expect(
          resolveCodexSessionBinding({ bindingStore: store, identity: current, storePath }),
        ).resolves.toMatchObject({ binding: undefined });
        expect(store.read(previous)).toEqual(binding);
        await expect(
          reclaimCurrentCodexSessionGeneration({
            bindingStore: store,
            identity: current,
            storePath,
          }),
        ).resolves.toBe(mismatch !== "two generations behind" || !supervision);
        expect(store.read(current)).toBeUndefined();
        expect(store.read(previous)).toEqual(
          mismatch === "two generations behind" && !supervision ? undefined : binding,
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("rechecks predecessor adoption authority after the lazy store resolves", async () => {
    const { state } = createStateStore();
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-previous",
      sessionKey: "agent:main:compaction",
    };
    const current = { ...previous, sessionId: "session-current" };
    const binding = { threadId: "native-thread", cwd: "/repo" };
    await createCodexAppServerBindingStore(state).mutate(previous, { kind: "set", binding });
    const store = createLazyCodexAppServerBindingStore(state);
    let active = true;
    const adopting = store.adoptSessionGeneration(current, previous.sessionId, () => {
      if (!active) {
        throw new Error("admission authority closed");
      }
    });
    active = false;

    await expect(adopting).rejects.toThrow("admission authority closed");
    expect(store.read(current)).toBeUndefined();
    expect(store.read(previous)).toEqual(binding);
  });

  it("rejects reclaim when another session generation wins after verification", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });

    const plan = await store.prepareSessionGenerationReclaim(second);
    expect(plan).toEqual({ kind: "verify", expectedPreviousSessionId: first.sessionId });
    await expect(store.adoptSessionGeneration(third, first.sessionId)).resolves.toBe("adopted");
    if (plan.kind !== "verify") {
      throw new Error("expected stale session generation");
    }
    await expect(
      store.mutate(second, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: plan.expectedPreviousSessionId,
      }),
    ).resolves.toBe(false);
    expect(store.read(third)).toMatchObject({ threadId: "thread-1" });
  });

  it("falls back to physical session identity when no stable session key exists", () => {
    const first = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    const second = { ...first, sessionId: "session-2" };

    expect(bindingStoreKey(first)).not.toBe(bindingStoreKey(second));
  });

  it("does not create a retirement tombstone for a session without a Codex binding", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };

    await expect(store.retireSessionGeneration(identity)).resolves.toBe("absent");
    expect(values.size).toBe(0);
  });

  it("expires physical-session retirement fences but retains stable-key fences", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "app-server-thread-bindings-retirement-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const physical = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "physical-session",
      };
      const stable = {
        ...physical,
        sessionId: "stable-session",
        sessionKey: "agent:main:telegram:chat-1",
      };
      for (const identity of [physical, stable]) {
        await store.mutate(identity, {
          kind: "set",
          binding: { threadId: `thread-${identity.sessionId}`, cwd: "/repo" },
        });
        await expect(store.retireSessionGeneration(identity)).resolves.toBe("applied");
      }

      expect(state.lookup(bindingStoreKey(physical))).toMatchObject({
        state: "cleared",
        retired: true,
      });
      expect(state.lookup(bindingStoreKey(stable))).toMatchObject({
        state: "cleared",
        retired: true,
      });

      vi.advanceTimersByTime(2 * 60_000);

      expect(state.lookup(bindingStoreKey(physical))).toBeUndefined();
      expect(state.lookup(bindingStoreKey(stable))).toMatchObject({
        state: "cleared",
        retired: true,
      });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("claims a cleared binding once without allowing the retired generation back in", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-premature", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);

    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(true);

    expect(store.read(previous)).toBeUndefined();
    expect(store.read(current)).toMatchObject({
      threadId: "thread-new",
      cwd: "/new",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    expect(values.size).toBe(1);
  });

  it("reclaims a stale stable generation only for the current OpenClaw session", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: "other-session",
      }),
    ).resolves.toBe(false);
    expect(values.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: "session-1",
    });

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    expect(values.get(bindingStoreKey(current))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: "session-2",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed-before-commit", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(true);

    await expect(
      store.mutate(previous, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    expect(store.read(current)).toMatchObject({ threadId: "thread-new" });
  });

  it("preserves a stale private supervision binding instead of reclaiming it as empty", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:supervised",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: {
        threadId: "thread-supervised",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-source",
        cwd: "/repo",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
      },
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-replacement", cwd: "/other" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(previous, { kind: "clear", threadId: "thread-supervised" }),
    ).resolves.toBe(false);

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(false);
    expect(values.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: previous.sessionId,
      binding: { threadId: "thread-supervised", connectionScope: "supervision" },
    });
    expect(store.read(previous)).toMatchObject({
      threadId: "thread-supervised",
      connectionScope: "supervision",
    });
    expect(store.read(current)).toBeUndefined();
  });

  it("fences a retired physical generation until its successor claims the stable key", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });

    await expect(store.retireSessionGeneration(previous)).resolves.toBe("applied");
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);
    expect(values.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(store.withLease(previous, async () => undefined)).rejects.toThrow(
      "generation was retired",
    );

    await store.withLease(current, async () => undefined);
    expect(values.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/stale" },
      }),
    ).resolves.toBe(false);

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
      }),
    ).resolves.toBe(true);
    expect(store.read(current)).toMatchObject({ threadId: "thread-new" });
  });

  it("keeps a retired in-place generation fenced until it is verified", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await store.retireSessionGeneration(identity);

    await expect(store.resetSessionGeneration(identity)).resolves.toBe("conflict");
    expect(values.get(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: identity.sessionId,
    });
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-unverified", cwd: "/new" },
      }),
    ).resolves.toBe(false);
  });

  it("verifies and releases a retired fence for the still-current stable session id", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await store.retireSessionGeneration(identity);

    const plan = await store.prepareSessionGenerationReclaim(identity);
    expect(plan).toEqual({
      kind: "verify",
      expectedPreviousSessionId: identity.sessionId,
    });
    if (plan.kind !== "verify") {
      throw new Error("expected the current retired generation to require verification");
    }
    await expect(
      store.mutate(identity, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: plan.expectedPreviousSessionId,
      }),
    ).resolves.toBe(true);
    expect(values.get(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: identity.sessionId,
    });
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-recovered", cwd: "/new" },
      }),
    ).resolves.toBe(true);
  });

  it("recovers a retired in-place generation through the authoritative session store", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "openclaw-codex-reset-reclaim-",
      layout: "state-only",
      applyEnv: false,
    });
    const root = fixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:telegram:direct:123",
    };
    try {
      await upsertSessionEntry({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        storePath,
        entry: { sessionId: identity.sessionId, updatedAt: 1 },
      });
      await store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-before-reset", cwd: "/repo" },
      });
      await store.retireSessionGeneration(identity);

      await expect(
        reclaimCurrentCodexSessionGeneration({
          bindingStore: store,
          identity,
          config: { session: { store: storePath } },
        }),
      ).resolves.toBe(true);
      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-after-reset", cwd: "/repo" },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("hashes stable session keys and keeps agent ownership distinct", () => {
    const sessionKey = "agent:main:telegram:private-peer@example.com";
    const first = bindingStoreKey({
      kind: "session",
      agentId: "first",
      sessionId: "session-1",
      sessionKey,
    });
    const second = bindingStoreKey({
      kind: "session",
      agentId: "second",
      sessionId: "session-2",
      sessionKey,
    });

    expect(first).toMatch(/^session-key:first:[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("private-peer");
    expect(second).not.toBe(first);
  });

  it("patches only the expected thread without advancing history implicitly", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    const historyCoveredThrough = "2026-01-01T00:00:00.000Z";
    await store.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        model: "gpt-5.4-codex",
        historyCoveredThrough,
      },
    });

    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: "thread-1",
        patch: { serviceTier: "fast" },
      }),
    ).resolves.toBe(true);
    expect(store.read(identity)).toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      serviceTier: "priority",
      historyCoveredThrough,
    });
  });

  it("rejects stale patches and absent-only writes", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: "thread-old",
        patch: { model: "stale-model" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/repo" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    expect(store.read(identity)).toMatchObject({ threadId: "thread-new" });
  });

  it("rejects empty storage identities", () => {
    expect(() => bindingStoreKey({ kind: "session", agentId: "main", sessionId: " " })).toThrow(
      "requires a session id",
    );
    expect(() =>
      bindingStoreKey({ kind: "session", agentId: " ", sessionId: "session-1" }),
    ).toThrow("requires an agent id");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
