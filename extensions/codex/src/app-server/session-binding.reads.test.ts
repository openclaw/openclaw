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
  createStoredCodexAppServerBinding as importStoredBinding,
  hashCodexAppServerBindingFingerprint as hashFingerprint,
  readCodexAppServerThreadBinding as decodeBinding,
  createCodexAppServerBindingStore as createBindingStore,
  resolveCodexSessionBinding as resolveBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore as createSqliteState } from "./session-binding.sqlite.test-helpers.js";
import { createCodexTestBindingStateStore as createStateStore } from "./session-binding.test-helpers.js";

const fixtures: Awaited<ReturnType<typeof createOpenClawTestState>>[] = [];
async function createStateFixture(prefix: string) {
  const fixture = await createOpenClawTestState({ prefix, layout: "state-only", applyEnv: false });
  fixtures.push(fixture);
  return fixture;
}

async function createAuthorityFixture(prefix: string, sessionKey: string) {
  const fixture = await createStateFixture(prefix);
  const storePath = path.join(fixture.stateDir, "sessions.json");
  const store = createBindingStore(createStateStore());
  const identity = { kind: "session" as const, agentId: "main", sessionId: "current", sessionKey };
  const scope = { agentId: identity.agentId, sessionKey, storePath };
  const resolve = (overrides: Partial<Parameters<typeof resolveBinding>[0]> = {}) =>
    resolveBinding({ bindingStore: store, identity, storePath, ...overrides });
  return { storePath, store, identity, scope, resolve };
}

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  for (const fixture of fixtures.splice(0)) {
    await fixture.cleanup();
  }
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
    ["thread", "thread-new", "client-old", "client-old"],
    ["physical client", "thread-old", "client-new", "client-old"],
    ["previously absent client", "thread-old", "client-new", undefined],
  ] as const)(
    "keeps a replacement %s when stale mutations complete later",
    async (_, threadId, clientId, initialClientId) => {
      const state = createStateStore();
      const store = createBindingStore(state);
      const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
      const original = {
        threadId: "thread-old",
        clientId: initialClientId,
        cwd: "/repo",
      };
      const successor = { ...original, threadId, clientId };
      await store.mutate(identity, { kind: "set", binding: original });
      await expect(
        store.mutate(identity, {
          kind: "patch",
          threadId: original.threadId,
          clientId: original.clientId,
          patch: { cwd: original.cwd },
        }),
      ).resolves.toBe(true);
      await store.mutate(identity, { kind: "set", binding: successor });

      const staleOwner = {
        kind: "clear" as const,
        threadId: original.threadId,
        clientId: original.clientId,
      };
      await expect(
        store.mutate(identity, {
          ...staleOwner,
          kind: "patch",
          patch: { model: "must-not-publish" },
        }),
      ).resolves.toBe(false);
      await expect(store.mutate(identity, staleOwner)).resolves.toBe(false);
      expect(store.read(identity)).toEqual(successor);
      const currentClear = {
        kind: "clear" as const,
        threadId: successor.threadId,
        clientId: successor.clientId,
      };
      await expect(store.mutate(identity, currentClear)).resolves.toBe(true);
      expect(store.read(identity)).toBeUndefined();
    },
  );

  it("rechecks physical ownership after a worker comparison loses to a same-thread successor", async () => {
    const fixture = await createStateFixture("codex-client-cas-");
    const options = {
      namespace: "physical-owner-cas",
      maxEntries: 10,
      env: { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir },
    };
    const state = createSqliteState(options);
    const store = createBindingStore(state);
    const peer = createBindingStore(createSqliteState(options));
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "same-session",
      sessionKey: "agent:main:client-cas",
    };
    const original = { threadId: "same-thread", clientId: "client-a", cwd: "/repo" };
    const successor = { ...original, clientId: "client-b" };
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
  });

  it("keeps ordered failures without synchronous reads or retrying failed bulk acquisition", async () => {
    const state = createStateStore();
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
    const state = createStateStore();
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
  it("keeps borrowed settlement authority through cancellation while observing parent revocation", async () => {
    const { store, identity, scope, resolve } = await createAuthorityFixture(
      "codex-settlement-authority-",
      "agent:main:settlement",
    );
    const abort = new AbortController();
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: identity.sessionId, updatedAt: 1 },
    });
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "native-thread", cwd: "/repo" },
    });
    const retained = await resolve({ signal: abort.signal });
    const settlement = retained.authority.withLiveness(() => {});
    try {
      const child = await resolve({ authority: retained.authority });
      child.release();
      expect(() => child.authority.assertLegacyCurrent()).toThrow();
      expect(() => retained.authority.assertLegacyCurrent()).not.toThrow();
      abort.abort(new Error("foreground canceled"));
      expect(() => retained.authority.assertLegacyCurrent()).toThrow("foreground canceled");
      expect(() => settlement.assertLegacyCurrent()).not.toThrow();
      await patchSessionEntry({ ...scope, update: () => ({ updatedAt: 2 }) });
      expect(() => settlement.assertLegacyCurrent()).not.toThrow();
      await patchSessionEntry({
        ...scope,
        update: () => ({ previousSessionId: "replacement-predecessor" }),
      });
      expect(() => settlement.assertLegacyCurrent()).toThrow(
        "Codex session generation is no longer current",
      );
    } finally {
      retained.release();
    }
  });

  it("combines lease and mutation lineage and refuses a same-id predecessor change", async () => {
    const { storePath, store, identity, resolve } = await createAuthorityFixture(
      "codex-combined-authority-",
      "agent:main:lease",
    );
    const source = { ...identity, sessionKey: "agent:main:mutation" };
    const binding = { threadId: "native-thread", cwd: "/repo" };
    for (const target of [identity, source]) {
      await upsertSessionEntry({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        storePath,
        entry: { sessionId: target.sessionId, previousSessionId: "previous", updatedAt: 1 },
      });
    }
    await store.mutate(identity, { kind: "set", binding });
    using captures = new DisposableStack();
    const lease = await resolve();
    captures.defer(() => lease.release());
    const mutation = await resolve({ identity: source });
    captures.defer(() => mutation.release());
    const publishModel = (model: string) =>
      store.mutate(
        identity,
        {
          kind: "patch",
          threadId: binding.threadId,
          patch: { model },
        },
        mutation.authority.assertCurrent,
        mutation.authority,
      );
    await store.withLease(
      identity,
      async () => {
        await expect(publishModel("first")).resolves.toBe(true);
        await patchSessionEntry({
          agentId: source.agentId,
          sessionKey: source.sessionKey,
          storePath,
          update: () => ({ previousSessionId: "changed-without-new-session-id" }),
        });
        expect(() => mutation.authority.assertCurrent()).toThrow(
          "Codex session generation is no longer current",
        );
        await expect(publishModel("must-not-publish")).rejects.toThrow(
          "Codex session generation is no longer current",
        );
        expect(store.read(identity)?.model).toBe("first");
      },
      { authority: lease.authority, assertCurrent: lease.authority.assertCurrent },
    );
  });
});

async function importBinding(fields: Record<string, unknown>) {
  return await importStoredBinding({
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
      decodeBinding({
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
      dynamicToolsFingerprint: hashFingerprint(rawDynamicToolsFingerprint),
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: hashFingerprint(rawUserMcpServersFingerprint),
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
    const { stateDir } = await createStateFixture("openclaw-codex-binding-state-");
    const state = createSqliteState({
      namespace: "app-server-thread-bindings-json-test",
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const store = createBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-json" };
    const contextEngine = {
      schemaVersion: 1 as const,
      engineId: "lossless-claw",
      policyFingerprint: "policy-1",
    };

    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: {
          threadId: "thread-json",
          cwd: "/repo",
          model: undefined,
          contextEngine: { ...contextEngine, projection: undefined },
        },
      }),
    ).resolves.toBe(true);
    expect(state.lookup(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "active",
      binding: {
        threadId: "thread-json",
        cwd: "/repo",
        contextEngine,
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
  });

  it.each([
    { destructiveApprovalMode: "ask", appId: "not-allowed" },
    { destructiveApprovalMode: "on-request" },
  ])("drops invalid imported policy contexts: %j", async (fields) => {
    expect(await importPolicy(fields)).toBeUndefined();
  });
});
