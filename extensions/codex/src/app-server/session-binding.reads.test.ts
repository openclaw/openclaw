import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerThreadBinding,
  createCodexAppServerBindingStore,
  resolveCodexSessionBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

describe("Codex app-server binding reads", () => {
  it.each([
    {
      changed: "thread",
      threadId: "thread-new",
      clientId: "client-old",
      initialClientId: "client-old",
    },
    {
      changed: "physical client",
      threadId: "thread-old",
      clientId: "client-new",
      initialClientId: "client-old",
    },
    {
      changed: "previously absent client",
      threadId: "thread-old",
      clientId: "client-new",
      initialClientId: undefined,
    },
  ])("keeps a replacement $changed when stale mutations complete later", async (successorOwner) => {
    const state = createCodexTestBindingStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    const original = {
      threadId: "thread-old",
      clientId: successorOwner.initialClientId,
      cwd: "/repo",
    };
    const successor = {
      threadId: successorOwner.threadId,
      clientId: successorOwner.clientId,
      cwd: "/repo",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: original,
    });
    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: original.threadId,
        clientId: original.clientId,
        patch: { cwd: original.cwd },
      }),
    ).resolves.toBe(true);
    await store.mutate(identity, {
      kind: "set",
      binding: successor,
    });

    const stalePatch = {
      kind: "patch" as const,
      threadId: original.threadId,
      clientId: original.clientId,
      patch: { model: "must-not-publish" },
    };
    const staleClear = {
      kind: "clear" as const,
      threadId: original.threadId,
      clientId: original.clientId,
    };
    await expect(store.mutate(identity, stalePatch)).resolves.toBe(false);
    await expect(store.mutate(identity, staleClear)).resolves.toBe(false);
    expect(store.read(identity)).toEqual(successor);
    const currentClear = {
      kind: "clear" as const,
      threadId: successor.threadId,
      clientId: successor.clientId,
    };
    await expect(store.mutate(identity, currentClear)).resolves.toBe(true);
    expect(store.read(identity)).toBeUndefined();
  });

  it("rechecks physical ownership after a worker comparison loses to a same-thread successor", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "codex-client-cas-",
      layout: "state-only",
      applyEnv: false,
    });
    const options = {
      namespace: "physical-owner-cas",
      maxEntries: 10,
      env: { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir },
    };
    const state = createCodexSqliteTestBindingStateStore(options);
    const store = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(createCodexSqliteTestBindingStateStore(options));
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "same-session",
      sessionKey: "agent:main:client-cas",
    };
    const original = { threadId: "same-thread", clientId: "client-a", cwd: "/repo" };
    const successor = { ...original, clientId: "client-b" };
    try {
      await store.mutate(identity, { kind: "set", binding: original });
      const withCurrent = state.withCurrent.bind(state);
      let replaced = false;
      const outcomes: string[] = [];
      state.withCurrent = (authority) => {
        const view = withCurrent(authority);
        return {
          ...view,
          async compareAndApply(...args) {
            if (!replaced) {
              replaced = true;
              await peer.mutate(identity, { kind: "set", binding: successor });
            }
            const outcome = await view.compareAndApply(...args);
            outcomes.push(outcome.status);
            return outcome;
          },
        };
      };
      const staleClear = {
        kind: "clear" as const,
        threadId: original.threadId,
        clientId: original.clientId,
      };
      await expect(store.mutate(identity, staleClear)).resolves.toBe(false);
      expect(outcomes).toContain("conflict");
      expect(await collect(peer.readMany([identity]))).toEqual([successor]);
      const currentClear = {
        kind: "clear" as const,
        threadId: successor.threadId,
        clientId: successor.clientId,
      };
      await expect(peer.mutate(identity, currentClear)).resolves.toBe(true);
      expect(await collect(peer.readMany([identity]))).toEqual([undefined]);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      await fixture.cleanup();
    }
  });

  it("keeps ordered failures without synchronous reads or retrying failed bulk acquisition", async () => {
    const state = createCodexTestBindingStateStore();
    const readValue = state.lookup.bind(state);
    const syncLookup = vi.spyOn(state, "lookup");
    const lookup = vi.spyOn(state.asyncReads, "lookup");
    const lookupMany = vi.fn(async (keys: readonly string[]) =>
      keys.map((key) => ({ ok: true as const, value: readValue(key) })),
    );
    const store = createLazyCodexAppServerBindingStore({
      ...state,
      asyncReads: { ...state.asyncReads, lookup, lookupMany },
    });
    const first = { kind: "conversation" as const, bindingId: "first" };
    const invalid = { kind: "conversation" as const, bindingId: " " };
    state.register(bindingStoreKey(first), {
      version: 1,
      state: "active",
      binding: { threadId: "", cwd: "/repo" },
    });
    await expect(collect(store.readMany([first, invalid]))).rejects.toThrow(
      "Invalid Codex app-server binding row: conversation:first",
    );
    expect(lookupMany).not.toHaveBeenCalled();
    state.delete(bindingStoreKey(first));
    await expect(collect(store.readMany([first, invalid]))).rejects.toThrow(
      "Codex app-server conversation binding requires a binding id",
    );
    lookup.mockClear();
    const failure = new Error("bulk database unavailable");
    lookupMany.mockImplementation(async () => {
      throw failure;
    });
    await expect(
      collect(store.readMany([first, { ...first, bindingId: "second" }])),
    ).rejects.toThrow(failure);
    expect(lookupMany).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(syncLookup).not.toHaveBeenCalled();
  });

  it("keeps async fallback and oversized cohorts readable without synchronous acquisition", async () => {
    const state = createCodexTestBindingStateStore();
    const readValue = state.lookup.bind(state);
    const syncLookup = vi.spyOn(state, "lookup");
    const first = { kind: "conversation" as const, bindingId: "first" };
    const last = { kind: "conversation" as const, bindingId: "last" };
    const binding = { threadId: "owned", cwd: "/repo" };
    state.register(bindingStoreKey(last), { version: 1, state: "active", binding });
    const legacy = createLazyCodexAppServerBindingStore({
      ...state,
      asyncReads: { ...state.asyncReads, lookupMany: undefined },
    });
    expect(await collect(legacy.readMany([first, last]))).toEqual([undefined, binding]);
    const lookupMany = vi.fn(async (keys: readonly string[]) => {
      if (keys.length > 10_000) {
        throw new Error("host bulk limit exceeded");
      }
      return keys.map((key) => ({ ok: true as const, value: readValue(key) }));
    });
    const store = createLazyCodexAppServerBindingStore({
      ...state,
      asyncReads: { ...state.asyncReads, lookupMany },
    });
    const identities = [...Array.from({ length: 10_000 }, () => first), last];
    const result = await collect(store.readMany(identities));
    expect(result).toHaveLength(identities.length);
    expect(result.slice(0, -1).every((value) => value === undefined)).toBe(true);
    expect(result.at(-1)).toEqual(binding);
    expect(lookupMany.mock.calls.map(([keys]) => keys.length)).toEqual([10_000, 1]);
    expect(syncLookup).not.toHaveBeenCalled();
  });
  it("combines lease and mutation lineage and refuses a same-id predecessor change", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "codex-combined-authority-",
      layout: "state-only",
      applyEnv: false,
    });
    const storePath = path.join(fixture.stateDir, "sessions.json");
    const store = createCodexAppServerBindingStore(createCodexTestBindingStateStore());
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "current",
      sessionKey: "agent:main:lease",
    };
    const source = { ...identity, sessionKey: "agent:main:mutation" };
    const binding = { threadId: "native-thread", cwd: "/repo" };
    try {
      for (const target of [identity, source]) {
        await upsertSessionEntry({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          storePath,
          entry: { sessionId: target.sessionId, previousSessionId: "previous", updatedAt: 1 },
        });
      }
      await store.mutate(identity, { kind: "set", binding });
      const lease = await resolveCodexSessionBinding({ bindingStore: store, identity, storePath });
      const mutation = await resolveCodexSessionBinding({
        bindingStore: store,
        identity: source,
        storePath,
      });
      await store.withLease(
        identity,
        async () => {
          await expect(
            store.mutate(
              identity,
              {
                kind: "patch",
                threadId: binding.threadId,
                patch: { model: "first" },
              },
              mutation.authority.assertCurrent,
              mutation.authority,
            ),
          ).resolves.toBe(true);
          await patchSessionEntry({
            agentId: source.agentId,
            sessionKey: source.sessionKey,
            storePath,
            update: () => ({ previousSessionId: "changed-without-new-session-id" }),
          });
          // Pure caller liveness remains valid. Only the fresh composed source
          // validation can refuse this mutation, even though its lease is current.
          mutation.authority.assertCurrent();
          await expect(
            store.mutate(
              identity,
              {
                kind: "patch",
                threadId: binding.threadId,
                patch: { model: "must-not-publish" },
              },
              mutation.authority.assertCurrent,
              mutation.authority,
            ),
          ).rejects.toThrow("Codex session generation is no longer current");
          expect(store.read(identity)?.model).toBe("first");
        },
        { authority: lease.authority, assertCurrent: lease.authority.assertCurrent },
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

async function importBinding(fields: Record<string, unknown>) {
  return await createStoredCodexAppServerBinding({
    schemaVersion: 2,
    threadId: "thread-1",
    cwd: "/repo",
    ...fields,
  });
}

async function importPolicy(fields: Record<string, unknown>) {
  return (
    await importBinding({
      pluginAppPolicyContext: {
        fingerprint: "policy",
        apps: {
          app: {
            configKey: "app",
            marketplaceName: "openai-curated",
            pluginName: "plugin",
            allowDestructiveActions: true,
            mcpServerNames: [],
            ...fields,
          },
        },
        pluginAppIds: {},
      },
    })
  )?.binding.pluginAppPolicyContext;
}

describe("Codex app-server binding codec", () => {
  it("migrates the retired on-failure approval policy", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-policy",
        cwd: "/repo",
        approvalPolicy: "on-failure",
        sandbox: "workspace-write",
      }),
    ).toEqual({
      threadId: "thread-policy",
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("rejects unsafe marketplace names in imported plugin app ownership", async () => {
    expect(await importPolicy({ marketplaceName: "../unsafe-marketplace" })).toBeUndefined();
  });

  it("normalizes legacy fingerprints without rehashing canonical values", async () => {
    const rawDynamicToolsFingerprint = JSON.stringify([{ name: "legacy_tool" }]);
    const rawUserMcpServersFingerprint = JSON.stringify({
      mcp_servers: { legacy: { command: "node" } },
    });
    const nativeSkillIsolationFingerprint = `sha256:${"b".repeat(64)}`;
    const imported = await importBinding({
      updatedAt: "2026-01-01T00:00:00.000Z",
      dynamicToolsFingerprint: rawDynamicToolsFingerprint,
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: rawUserMcpServersFingerprint,
    });
    expect(imported?.binding).toMatchObject({
      dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(rawDynamicToolsFingerprint),
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: hashCodexAppServerBindingFingerprint(rawUserMcpServersFingerprint),
    });

    const existingHash = `sha256:${"a".repeat(64)}`;
    const canonical = await importBinding({
      updatedAt: "2026-01-01T00:00:00.000Z",
      dynamicToolsFingerprint: "[]",
      userMcpServersFingerprint: existingHash,
    });
    expect(canonical?.binding).toMatchObject({
      dynamicToolsFingerprint: "[]",
      userMcpServersFingerprint: existingHash,
    });
  });

  it("canonicalizes undefined fields and preserves empty instruction snapshots in JSON-only plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createCodexSqliteTestBindingStateStore({
        namespace: "app-server-thread-bindings-json-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const identity = { kind: "conversation" as const, bindingId: "binding-json" };

      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-json",
            cwd: "/repo",
            model: undefined,
            contextEngine: {
              schemaVersion: 1,
              engineId: "lossless-claw",
              policyFingerprint: "policy-1",
              projection: undefined,
            },
          },
        }),
      ).resolves.toBe(true);
      expect(state.lookup(bindingStoreKey(identity))).toEqual({
        version: 1,
        state: "active",
        binding: {
          threadId: "thread-json",
          cwd: "/repo",
          contextEngine: {
            schemaVersion: 1,
            engineId: "lossless-claw",
            policyFingerprint: "policy-1",
          },
        },
      });

      await expect(
        store.mutate(identity, {
          kind: "patch",
          threadId: "thread-json",
          patch: { contextEngine: undefined },
        }),
      ).resolves.toBe(true);
      expect(store.read(identity)).toEqual({
        threadId: "thread-json",
        cwd: "/repo",
      });
      expect(state.lookup(bindingStoreKey(identity))).not.toHaveProperty("lease");

      for (const snapshot of [undefined, "", "Follow the saved workspace instructions."]) {
        const binding = {
          threadId: "thread-json",
          cwd: "/repo",
          ...(snapshot !== undefined ? { agentWorkspaceDeveloperInstructions: snapshot } : {}),
        };
        await store.mutate(identity, { kind: "set", binding });
        expect(store.read(identity)).toEqual(binding);
        expect(state.lookup(bindingStoreKey(identity))).toEqual({
          version: 1,
          state: "active",
          binding,
        });
        const imported = await importBinding({
          ...binding,
          createdAt: "2025-12-31T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(imported?.binding).toEqual({
          ...binding,
          historyCoveredThrough: "2026-01-01T00:00:00.000Z",
        });
      }

      await expect(store.mutate(identity, { kind: "clear" })).resolves.toBe(true);
      expect(store.read(identity)).toBeUndefined();
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    { destructiveApprovalMode: "ask", appId: "not-allowed" },
    { destructiveApprovalMode: "on-request" },
  ])("drops invalid imported policy contexts: %j", async (fields) => {
    expect(await importPolicy(fields)).toBeUndefined();
  });
});
