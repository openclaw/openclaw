// Codex tests cover durable recovery receipts and exact-owner deletion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding store", () => {
  it("preserves accepted and settling turn receipts across SQLite reopen without changing legacy bindings", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-receipt-"));
    const options = {
      namespace: "turn-receipt",
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new" as const,
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    };
    const identity = { kind: "conversation" as const, bindingId: "owned-conversation" };
    const binding = { threadId: "owned-thread", clientId: "old-client", cwd: "/repo" };
    const reopen = async () => {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const store = createCodexAppServerBindingStore(
        createCodexSqliteTestBindingStateStore(options),
      );
      await store.withLease(identity, async () => {});
      return store;
    };
    try {
      let store = createCodexAppServerBindingStore(createCodexSqliteTestBindingStateStore(options));
      await store.mutate(identity, { kind: "set", binding });
      store = await reopen();
      expect(store.read(identity)).toEqual(binding);
      for (const state of ["accepted", "settling"] as const) {
        const turnRecovery = { turnId: "accepted-native-turn", state };
        await store.mutate(identity, {
          kind: "patch",
          threadId: binding.threadId,
          clientId: binding.clientId,
          patch: { turnRecovery },
        });
        store = await reopen();
        expect(store.read(identity)).toEqual({ ...binding, turnRecovery });
      }
      await store.mutate(identity, {
        kind: "patch",
        threadId: binding.threadId,
        clientId: binding.clientId,
        patch: { turnRecovery: undefined },
      });
      store = await reopen();
      expect(store.read(identity)).toEqual(binding);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes only the requested stable owner in SQLite", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-binding-delete-"));
    try {
      const state = createCodexSqliteTestBindingStateStore({
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
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
