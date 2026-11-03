import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  reclaimCurrentCodexSessionGeneration,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

function createStateStore() {
  const values = new Map<string, StoredCodexAppServerBinding>();
  const state = createCodexTestBindingStateStore(values);
  return { state, values };
}

export function registerSessionBindingRetirementTests() {
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
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createCodexSqliteTestBindingStateStore({
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

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2 * 60_000);

      expect(state.lookup(bindingStoreKey(physical))).toBeUndefined();
      expect(state.lookup(bindingStoreKey(stable))).toMatchObject({
        state: "cleared",
        retired: true,
      });
    } finally {
      await closeOpenClawStateDatabaseAsync();
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
}
