import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import {
  createNativeSubagentAssignmentStore,
  createNativeSubagentSubmissionStore,
} from "./native-subagent-assignment-store.js";
import { codexNativeSubagentRunId } from "./native-subagent-assignment.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { scopeCodexRunBindingStore } from "./session-binding-scope.js";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createStoredCodexAppServerBinding as importStoredBinding,
  hashCodexAppServerBindingFingerprint as hashFingerprint,
  readCodexAppServerThreadBinding as decodeBinding,
  createCodexAppServerBindingStore as createBindingStore,
  resolveCodexSessionBinding as resolveBinding,
  type CodexAppServerThreadBinding as ThreadBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore as createSqliteState } from "./session-binding.sqlite.test-helpers.js";
import { createCodexTestBindingStateStore as createStateStore } from "./session-binding.test-helpers.js";

const fixtures: Awaited<ReturnType<typeof createOpenClawTestState>>[] = [];
const superseded = "Codex session generation is no longer current";
async function createStateFixture(prefix: string) {
  const fixture = await createOpenClawTestState({ prefix, layout: "state-only", applyEnv: false });
  fixtures.push(fixture);
  return fixture;
}

async function createPersistedState(namespace: string, maxEntries = 10) {
  const { stateDir } = await createStateFixture(`codex-${namespace}-`);
  const options = {
    namespace,
    maxEntries,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  return {
    state: createSqliteState(options),
    peer: () => createBindingStore(createSqliteState(options)),
  };
}

async function createAuthorityFixture(name: string, previousSessionId?: string) {
  const fixture = await createStateFixture(`codex-${name}-`);
  const sessionKey = `agent:main:${name}`;
  const storePath = path.join(fixture.stateDir, "sessions.json");
  const store = createBindingStore(createStateStore());
  const identity = { kind: "session" as const, agentId: "main", sessionId: "current", sessionKey };
  const scope = { agentId: identity.agentId, sessionKey, storePath };
  const binding = { threadId: "native-thread", cwd: "/repo" };
  await upsertSessionEntry({
    ...scope,
    entry: { sessionId: identity.sessionId, previousSessionId, updatedAt: 1 },
  });
  await store.mutate(identity, { kind: "set", binding });
  const resolve = (overrides: Partial<Parameters<typeof resolveBinding>[0]> = {}) =>
    resolveBinding({ bindingStore: store, identity, storePath, ...overrides });
  return { store, identity, scope, resolve, binding };
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

const activeRow = (binding: ThreadBinding) => ({ version: 1, state: "active", binding }) as const;
const clearOwner = ({ threadId, clientId }: ThreadBinding) =>
  ({ kind: "clear", threadId, clientId }) as const;
function mutationExpectations(
  store: ReturnType<typeof createBindingStore>,
  identity: Parameters<typeof store.mutate>[0],
) {
  return (mutation: Parameters<typeof store.mutate>[1], applied = true) =>
    expect(store.mutate(identity, mutation)).resolves.toBe(applied);
}

function createReadFixture() {
  const state = createStateStore();
  const readValue = state.lookup.bind(state);
  const syncLookup = vi.spyOn(state, "lookup");
  const lookup = vi.spyOn(state.asyncReads, "lookup");
  const lookupMany = vi.fn(async (keys: readonly string[]) =>
    keys.map((key) => ({ ok: true as const, value: readValue(key) })),
  );
  const store = createLazyCodexAppServerBindingStore({
    ...state,
    asyncReads: { ...state.asyncReads, lookupMany },
  });
  return { state, store, readValue, syncLookup, lookup, lookupMany };
}

it.each([
  ["thread", "thread-new", "client-old", "client-old"],
  ["physical client", "thread-old", "client-new", "client-old"],
  ["previously absent client", "thread-old", "client-new", undefined],
] as const)(
  "keeps a replacement %s after stale mutations",
  async (_, threadId, clientId, initialClientId) => {
    const store = createBindingStore(createStateStore());
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    const original = { threadId: "thread-old", clientId: initialClientId, cwd: "/repo" };
    const successor = { ...original, threadId, clientId };
    const mutate = mutationExpectations(store, identity);
    await store.mutate(identity, { kind: "set", binding: original });
    const staleOwner = clearOwner(original);
    await mutate({ ...staleOwner, kind: "patch", patch: { cwd: original.cwd } });
    await store.mutate(identity, { kind: "set", binding: successor });
    await mutate({ ...staleOwner, kind: "patch", patch: { model: "must-not-publish" } }, false);
    await mutate(staleOwner, false);
    expect(store.read(identity)).toEqual(successor);
    await mutate(clearOwner(successor));
    expect(store.read(identity)).toBeUndefined();
  },
);

it("rechecks physical ownership after a worker comparison loses to a same-thread successor", async () => {
  const { state, peer: createPeer } = await createPersistedState("physical-owner-cas");
  const store = createBindingStore(state);
  const peer = createPeer();
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
  state.withCurrent = (authority) => {
    const view = withCurrent(authority);
    return {
      ...view,
      async compareAndApply(...args) {
        if (!replaced) {
          replaced = true;
          await peer.mutate(identity, { kind: "set", binding: successor });
        }
        return view.compareAndApply(...args);
      },
    };
  };
  await expect(store.mutate(identity, clearOwner(original))).resolves.toBe(false);
  expect(await collect(peer.readMany([identity]))).toEqual([successor]);
  await expect(peer.mutate(identity, clearOwner(successor))).resolves.toBe(true);
  expect(await collect(peer.readMany([identity]))).toEqual([undefined]);
});

it.each([
  ["eager", createBindingStore],
  ["lazy", createLazyCodexAppServerBindingStore],
] as const)("%s prepared binding observes native and worker commits", async (_, createStore) => {
  const { state } = await createPersistedState("prepared-binding");
  const store = createStore(state);
  const identity = { kind: "session" as const, agentId: "main", sessionId: "current" };
  const key = bindingStoreKey(identity);
  const original = { threadId: "original", cwd: "/repo" };
  const replacement = { threadId: "replacement", cwd: "/repo" };
  state.register(key, activeRow(original));
  const current = await store.prepareRead(identity);
  expect(current).toBeDefined();
  const logicalIdentity = { ...identity, sessionId: "logical-session" };
  const scoped = scopeCodexRunBindingStore({
    bindingStore: store,
    logicalIdentity,
    physicalIdentity: identity,
  });
  const scopedCurrent = await scoped.prepareRead(logicalIdentity);
  expect(scopedCurrent).toBeDefined();
  const lookup = vi.spyOn(state, "lookup");
  try {
    expect(current?.read()).toEqual(original);
    expect(scopedCurrent?.read()).toEqual(original);
    state.register(key, activeRow(replacement));
    expect(current?.read()).toEqual(replacement);
    expect(scopedCurrent?.read()).toEqual(replacement);
    state.delete(key);
    expect(current?.read()).toBeUndefined();
    await store.mutate(identity, { kind: "set", binding: original });
    expect(current?.read()).toEqual(original);
    await store.mutate(identity, { kind: "set", binding: replacement });
    expect(current?.read()).toEqual(replacement);
    await store.mutate(identity, { kind: "clear" });
    expect(current?.read()).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    current?.release();
    scopedCurrent?.release();
  }
});

it("keeps native monitor guards current through worker-published binding reads", async () => {
  const { state, peer: createPeer } = await createPersistedState("prepared-native-read");
  const store = createLazyCodexAppServerBindingStore(state);
  const identity = { kind: "session" as const, agentId: "main", sessionId: "prepared-native" };
  const binding = {
    threadId: "parent-thread",
    cwd: "/repo",
    appServerRuntimeFingerprint: "runtime-one",
  };
  await store.mutate(identity, { kind: "set", binding });
  vi.spyOn(state, "lookup").mockImplementation(() => {
    throw new Error("Native guards must not open a synchronous database");
  });
  const reader = await store.prepareRead(identity);
  if (!reader) {
    throw new Error("Expected a prepared native binding reader");
  }
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: identity.sessionId,
    binding,
  });
  if (!owner) {
    throw new Error("Expected a native history owner");
  }
  const common = { bindingStore: store, readBinding: reader.read, identity, owner };
  const submissions = createNativeSubagentSubmissionStore({
    ...common,
    assertLifecycleCurrentAsync: async () => {},
  });
  const assignments = createNativeSubagentAssignmentStore(common);
  const expectStale = () => {
    expect(() => submissions.assertCurrent()).toThrow(
      "Native submission binding is no longer current",
    );
    expect(() => assignments.assertCurrent()).toThrow(
      "Native assignment binding is no longer current",
    );
  };
  try {
    expect(reader.read()).toEqual(binding);
    await submissions.assertCurrentAsync();
    await assignments.assertCurrentAsync();
    const assignment = {
      runId: codexNativeSubagentRunId("child-thread"),
      childThreadId: "child-thread",
      nativeParentThreadId: binding.threadId,
      owner,
    };
    let sourceCurrent = true;
    const assertSourceCurrent = () => {
      if (!sourceCurrent) {
        throw new Error("Native source custody was revoked");
      }
    };
    await expect(assignments.record(assignment, assertSourceCurrent)).resolves.toBe(true);
    expect(await assignments.read()).toEqual([assignment]);
    const receipt = {
      parentTurnId: "parent-turn",
      callId: "child-call",
      childThreadId: "child-thread",
      submissionId: "child-turn",
      predecessorRunId: assignment.runId,
      predecessorNativeTurnId: "previous-child-turn",
    };
    await expect(submissions.record(receipt, assertSourceCurrent)).resolves.toBe(true);
    expect(await submissions.read()).toEqual([receipt]);
    await expect(submissions.consume(receipt, assertSourceCurrent)).resolves.toBe(true);
    await expect(assignments.consume(assignment, assertSourceCurrent)).resolves.toBe(true);
    expect(await assignments.read()).toEqual([]);
    sourceCurrent = false;
    await expect(assignments.record(assignment, assertSourceCurrent)).rejects.toThrow(
      "Native source custody was revoked",
    );
    const peer = createPeer();
    await peer.mutate(identity, { kind: "set", binding: { ...binding, threadId: "replacement" } });
    expectStale();
    await peer.mutate(identity, { kind: "set", binding });
    submissions.assertCurrent();
    assignments.assertCurrent();
  } finally {
    reader.release();
  }
  expect(reader.read()).toBeUndefined();
  expectStale();
});

it("propagates failed bulk acquisition without synchronous reads or retries", async () => {
  const { store, syncLookup, lookup, lookupMany } = createReadFixture();
  const first = { kind: "conversation" as const, bindingId: "first" };
  const failure = new Error("bulk database unavailable");
  lookupMany.mockImplementation(async () => {
    throw failure;
  });
  await expect(collect(store.readMany([first, { ...first, bindingId: "second" }]))).rejects.toThrow(
    failure,
  );
  expect(lookupMany).toHaveBeenCalledOnce();
  expect(lookup).not.toHaveBeenCalled();
  expect(syncLookup).not.toHaveBeenCalled();
});

it("keeps oversized cohorts readable without synchronous acquisition", async () => {
  const { state, store, readValue, syncLookup, lookupMany } = createReadFixture();
  const first = { kind: "conversation" as const, bindingId: "first" };
  const last = { kind: "conversation" as const, bindingId: "last" };
  const binding = { threadId: "owned", cwd: "/repo" };
  state.register(bindingStoreKey(last), activeRow(binding));
  lookupMany.mockImplementation(async (keys) => {
    if (keys.length > 10_000) {
      throw new Error("host bulk limit exceeded");
    }
    return keys.map((key) => ({ ok: true as const, value: readValue(key) }));
  });
  const identities = [...Array.from({ length: 10_000 }, () => first), last];
  const result = await collect(store.readMany(identities));
  expect(result).toHaveLength(identities.length);
  expect(result.slice(0, -1).every((value) => value === undefined)).toBe(true);
  expect(result.at(-1)).toEqual(binding);
  expect(syncLookup).not.toHaveBeenCalled();
});
it("keeps borrowed settlement authority through cancellation while observing parent revocation", async () => {
  const { scope, resolve } = await createAuthorityFixture("settlement");
  const abort = new AbortController();
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
    expect(() => settlement.assertLegacyCurrent()).toThrow(superseded);
  } finally {
    retained.release();
  }
});

it("combines lease and mutation lineage and refuses a same-id predecessor change", async () => {
  const { scope, store, identity, resolve, binding } = await createAuthorityFixture(
    "lease",
    "previous",
  );
  const source = { ...identity, sessionKey: "agent:main:mutation" };
  const sourceScope = { ...scope, sessionKey: source.sessionKey };
  await upsertSessionEntry({
    ...sourceScope,
    entry: { sessionId: identity.sessionId, previousSessionId: "previous", updatedAt: 1 },
  });
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
        ...sourceScope,
        update: () => ({ previousSessionId: "changed-without-new-session-id" }),
      });
      expect(() => mutation.authority.assertCurrent()).toThrow(superseded);
      await expect(publishModel("must-not-publish")).rejects.toThrow(superseded);
      expect(store.read(identity)?.model).toBe("first");
    },
    { authority: lease.authority, assertCurrent: lease.authority.assertCurrent },
  );
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

it("migrates the retired on-failure approval policy", () => {
  const binding = { threadId: "thread-policy", cwd: "/repo", sandbox: "workspace-write" };
  expect(decodeBinding({ ...binding, approvalPolicy: "on-failure" })).toEqual({
    ...binding,
    approvalPolicy: "on-request",
  });
});

it("rejects unsafe marketplace names in imported plugin app ownership", async () => {
  expect(await importPolicy({ marketplaceName: "../unsafe-marketplace" })).toBeUndefined();
});

it("normalizes legacy fingerprints without rehashing canonical values", async () => {
  const rawTools = JSON.stringify([{ name: "legacy_tool" }]);
  const rawServers = JSON.stringify({ mcp_servers: { legacy: { command: "node" } } });
  const nativeSkillIsolationFingerprint = `sha256:${"b".repeat(64)}`;
  const imported = await importBinding({
    updatedAt: "2026-01-01T00:00:00.000Z",
    dynamicToolsFingerprint: rawTools,
    nativeSkillIsolationFingerprint,
    userMcpServersFingerprint: rawServers,
  });
  expect(imported?.binding).toMatchObject({
    dynamicToolsFingerprint: hashFingerprint(rawTools),
    nativeSkillIsolationFingerprint,
    userMcpServersFingerprint: hashFingerprint(rawServers),
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
  const { state } = await createPersistedState(
    "app-server-thread-bindings-json-test",
    CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  );
  const store = createBindingStore(state);
  const identity = { kind: "conversation" as const, bindingId: "binding-json" };
  const baseBinding = { threadId: "thread-json", cwd: "/repo" };
  const readRow = () => state.lookup(bindingStoreKey(identity));
  const mutate = mutationExpectations(store, identity);
  const contextEngine = {
    schemaVersion: 1 as const,
    engineId: "lossless-claw",
    policyFingerprint: "policy-1",
  };

  await mutate({
    kind: "set",
    binding: {
      ...baseBinding,
      model: undefined,
      contextEngine: { ...contextEngine, projection: undefined },
    },
  });
  expect(readRow()).toEqual(activeRow({ ...baseBinding, contextEngine }));

  await mutate({
    kind: "patch",
    threadId: baseBinding.threadId,
    patch: { contextEngine: undefined },
  });
  expect(store.read(identity)).toEqual(baseBinding);
  expect(readRow()).not.toHaveProperty("lease");

  for (const snapshot of [undefined, "", "Follow the saved workspace instructions."]) {
    const binding = {
      ...baseBinding,
      ...(snapshot !== undefined ? { agentWorkspaceDeveloperInstructions: snapshot } : {}),
    };
    await store.mutate(identity, { kind: "set", binding });
    expect(store.read(identity)).toEqual(binding);
    expect(readRow()).toEqual(activeRow(binding));
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

  await mutate({ kind: "clear" });
  expect(store.read(identity)).toBeUndefined();
});

it.each([
  { destructiveApprovalMode: "ask", appId: "not-allowed" },
  { destructiveApprovalMode: "on-request" },
])("drops invalid imported policy contexts: %j", async (fields) => {
  expect(await importPolicy(fields)).toBeUndefined();
});
