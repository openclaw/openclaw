// Exact physical-client ownership regressions for the Codex binding store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

function createStateStore(): PluginStateSyncKeyedStore<StoredCodexAppServerBinding> {
  const values = new Map<string, StoredCodexAppServerBinding>();
  return {
    register: (key, value) => void values.set(key, value),
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
    deleteIf(key, predicate) {
      const value = values.get(key);
      return value !== undefined && predicate(value) && values.delete(key);
    },
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    clear: () => values.clear(),
  };
}

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("Codex app-server physical-client binding ownership", () => {
  it("clears only the exact physical client owner", async () => {
    const store = createCodexAppServerBindingStore(createStateStore());
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-clear-cas" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-shared", clientId: "client-new", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "clear",
        threadId: "thread-shared",
        clientId: "client-old",
      }),
    ).resolves.toBe(false);
    expect(store.read(identity)).toMatchObject({
      threadId: "thread-shared",
      clientId: "client-new",
    });

    await expect(
      store.mutate(identity, {
        kind: "clear",
        threadId: "thread-shared",
        clientId: "client-new",
      }),
    ).resolves.toBe(true);
    expect(store.read(identity)).toBeUndefined();
  });

  it("persists exact-client cleanup ownership across a SQLite store reopen", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-binding-client-owner-"));
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-client-owner",
    };
    const openStore = () =>
      createCodexAppServerBindingStore(
        createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
          namespace: "client-owner-reopen",
          maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: { ...process.env, OPENCLAW_STATE_DIR: root },
        }),
      );
    try {
      const fresh = openStore();
      await fresh.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-shared", clientId: "client-new", cwd: "/repo" },
      });
      await expect(
        fresh.mutate(identity, {
          kind: "clear",
          threadId: "thread-shared",
          clientId: "client-old",
        }),
      ).resolves.toBe(false);
      expect(fresh.read(identity)).toMatchObject({ clientId: "client-new" });

      resetPluginStateStoreForTests();
      const resumed = openStore();
      expect(resumed.read(identity)).toMatchObject({
        threadId: "thread-shared",
        clientId: "client-new",
      });
      await expect(
        resumed.mutate(identity, {
          kind: "clear",
          threadId: "thread-shared",
          clientId: "client-old",
        }),
      ).resolves.toBe(false);
      expect(resumed.read(identity)).toMatchObject({ clientId: "client-new" });
      await expect(
        resumed.mutate(identity, {
          kind: "clear",
          threadId: "thread-shared",
          clientId: "client-new",
        }),
      ).resolves.toBe(true);
      expect(resumed.read(identity)).toBeUndefined();
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
