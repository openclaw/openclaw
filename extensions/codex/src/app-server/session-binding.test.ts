import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey as storeKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore as createBindingStore,
  createStoredCodexAppServerBinding as importStoredBinding,
  hashCodexAppServerBindingFingerprint as hashFingerprint,
  readCodexAppServerThreadBinding as decodeBinding,
  reclaimCurrentCodexSessionGeneration as reclaimGeneration,
  resolveCodexSessionBinding as resolveBinding,
  type StoredCodexAppServerBinding as StoredBinding,
  type CodexAppServerBindingStore as BindingStore,
  type CodexAppServerThreadBinding as ThreadBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore as createSqliteState } from "./session-binding.sqlite.test-helpers.js";
import { createCodexTestBindingStateStore as createMemoryState } from "./session-binding.test-helpers.js";

type Identity = Parameters<BindingStore["mutate"]>[0];
type Mutation = Parameters<BindingStore["mutate"]>[1];

function createBindingFixture() {
  const values = new Map<string, StoredBinding>();
  const state = createMemoryState(values);
  return { state, values, store: createBindingStore(state) };
}

const sessionFixtures: Awaited<ReturnType<typeof createOpenClawTestState>>[] = [];
async function createSessionFixture(prefix: string) {
  const fixture = await createOpenClawTestState({ prefix, layout: "state-only", applyEnv: false });
  sessionFixtures.push(fixture);
  return { root: fixture.stateDir, storePath: path.join(fixture.stateDir, "sessions.json") };
}
async function createSqliteFixture(namespace: string, rejectNew = false) {
  const { root } = await createSessionFixture(`codex-${namespace}-`);
  const state = sqliteState(namespace, root, rejectNew);
  return { state, store: createBindingStore(state) };
}

function sqliteState(namespace: string, stateDir: string, rejectNew = false) {
  return createSqliteState({
    namespace,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    ...(rejectNew ? { overflowPolicy: "reject-new" as const } : {}),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function makeSessionIdentity(sessionId: string, agentId = "main") {
  return { kind: "session" as const, agentId, sessionId };
}

function makeStableSessionIdentity(sessionId: string, sessionKey: string) {
  return { ...makeSessionIdentity(sessionId), sessionKey };
}

function supervisionBinding(threadId: string, fields: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    threadId,
    cwd: "/repo",
    connectionScope: "supervision",
    supervisionSourceThreadId: "thread-source",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
    ...fields,
  };
}

function setBinding(store: BindingStore, identity: Identity, binding: ThreadBinding) {
  return store.mutate(identity, { kind: "set", binding });
}

function thread(threadId: string, fields: Partial<ThreadBinding> = {}): ThreadBinding {
  return { threadId, cwd: "/repo", ...fields };
}

const retiredRow = (sessionId: string) => ({
  version: 1,
  state: "cleared",
  retired: true,
  sessionId,
});

function nativeBinding(threadId: string, supervision: boolean): ThreadBinding {
  return {
    ...(supervision
      ? supervisionBinding(threadId, { supervisionSourceThreadId: "native-source" })
      : thread(threadId)),
    model: "gpt-5.6-luna",
    modelProvider: "openai",
  };
}

function reclaim(
  store: BindingStore,
  identity: ReturnType<typeof makeStableSessionIdentity>,
  storePath: string,
) {
  return reclaimGeneration({
    bindingStore: store,
    identity,
    config: { session: { store: storePath } },
  });
}

function recordSession(
  identity: ReturnType<typeof makeStableSessionIdentity>,
  storePath: string,
  previousSessionId?: string,
) {
  return upsertSessionEntry({
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    storePath,
    entry: {
      sessionId: identity.sessionId,
      ...(previousSessionId ? { previousSessionId } : {}),
      updatedAt: 1,
    },
  });
}

async function createGenerationFixture(threadId = "thread-old", cwd = "/old") {
  const fixture = createBindingFixture();
  const previous = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");
  await setBinding(fixture.store, previous, { threadId, cwd });
  return { ...fixture, previous, current: { ...previous, sessionId: "session-2" } };
}

async function expectMutation(
  store: BindingStore,
  identity: Identity,
  expected: boolean,
  mutation: Mutation,
) {
  await expect(store.mutate(identity, mutation)).resolves.toBe(expected);
}

function expectSet(
  store: BindingStore,
  identity: Identity,
  expected: boolean,
  threadId: string,
  cwd: string,
  ifAbsent = false,
) {
  return expectMutation(store, identity, expected, {
    kind: "set",
    binding: { threadId, cwd },
    ...(ifAbsent ? { if: { kind: "absent" as const } } : {}),
  });
}

function expectReclaim(
  store: BindingStore,
  identity: Identity,
  expected: boolean,
  previousId: string,
) {
  return expectMutation(store, identity, expected, {
    kind: "reclaim-generation",
    expectedPreviousSessionId: previousId,
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  for (const fixture of sessionFixtures.splice(0)) {
    await fixture.cleanup();
  }
});

describe("Codex app-server binding store", () => {
  it("rechecks resume authority after the lazy store resolves and before writing", async () => {
    const state = createMemoryState();
    const store = createLazyCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "pending-resume" };
    const binding = thread("thread-pending", { pendingResumeConfiguration: true });
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

  it.each<[string, string, ThreadBinding, boolean]>([
    ["stale owner", "thread-stale", thread("thread-new"), false],
    ["current owner", "thread-old", thread("thread-new"), true],
    ["same thread", "thread-old", thread("thread-old"), false],
    [
      "supervision",
      "thread-old",
      thread("thread-private", {
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-private",
        preserveNativeModel: true,
      }),
      false,
    ],
  ])("replaces only an exact ordinary owner: %s", async (_, expectedThreadId, binding, applied) => {
    const { store } = createBindingFixture();
    const identity = makeSessionIdentity("session-cas");
    const original = thread("thread-old");
    await setBinding(store, identity, original);
    await expectMutation(store, identity, applied, {
      kind: "replace-thread",
      expectedThreadId,
      binding,
    });
    expect(store.read(identity)).toEqual(applied ? binding : original);
  });

  it.each([
    ["current session", "session:main:current", "current", false],
    ["current conversation", "conversation:current", undefined, false],
    ["other conversation", "conversation:other", undefined, true],
    ["previous generation", "stable", "previous", true],
    ["missing generation", "stable", undefined, true],
    ["malformed", "conversation:malformed", undefined, false],
    ["cleared", "conversation:cleared", undefined, false],
  ] as const)("scans thread ownership: %s", async (kind, storedKey, sessionId, otherOwner) => {
    const { values, store } = createBindingFixture();
    const current =
      storedKey === "stable"
        ? makeStableSessionIdentity("current", "agent:main:stable")
        : kind === "current conversation"
          ? { kind: "conversation" as const, bindingId: "current" }
          : makeSessionIdentity("current");
    const key = storedKey === "stable" ? storeKey(current) : storedKey;
    const row = {
      version: 1 as const,
      binding: thread(kind === "malformed" ? "" : "thread-owned"),
      ...(sessionId ? { sessionId } : {}),
    };
    values.set(
      key,
      kind === "cleared"
        ? { ...row, state: "cleared", retired: true }
        : { ...row, state: "active" },
    );
    const scan = expect(store.hasOtherThreadOwner("thread-owned", current));
    if (kind === "malformed") {
      await scan.rejects.toThrow("Invalid Codex app-server binding row: " + key);
    } else {
      await scan.resolves.toBe(otherOwner);
    }
  });

  it("fails closed on malformed pending supervision state", async () => {
    const base = supervisionBinding("thread-source", {
      model: "gpt-5.6-luna",
      modelProvider: "openai",
    });
    const pending = { sourceThreadId: "thread-source" };
    expect(decodeBinding({ ...base, pendingSupervisionBranch: pending })).toMatchObject({
      ...base,
      pendingSupervisionBranch: pending,
    });
    for (const invalid of [
      { ...pending, cleanupThreadIds: ["thread-probe", "thread-probe"] },
      { ...pending, unknown: true },
    ]) {
      expect(decodeBinding({ ...base, pendingSupervisionBranch: invalid })).toBeUndefined();
    }
    expect(
      decodeBinding({ ...base, threadId: "thread-other", pendingSupervisionBranch: pending }),
    ).toBeUndefined();

    const { state, store } = createBindingFixture();
    const identity = makeSessionIdentity("session-corrupt");
    state.register(storeKey(identity), {
      version: 1,
      state: "active",
      binding: {
        ...base,
        pendingSupervisionBranch: { ...pending, cleanupThreadIds: ["thread-source"] },
      },
    } as never);

    expect(() => store.read(identity)).toThrow("Invalid Codex app-server binding row");
  });

  it("fails closed on malformed private supervision ownership", () => {
    const valid = supervisionBinding("thread-source", {
      pendingSupervisionBranch: { sourceThreadId: "thread-source" },
    });

    expect(decodeBinding({ ...valid, connectionScope: "user" })).toBeUndefined();
    expect(decodeBinding({ ...valid, connectionScope: {} })).toBeUndefined();
    expect(decodeBinding({ ...valid, supervisionSourceThreadId: undefined })).toBeUndefined();
  });

  it("commits a pending supervision branch only from its exact cleanup snapshot", async () => {
    const { store } = createBindingFixture();
    const identity = makeSessionIdentity("session-supervision-cas");
    const initial = {
      sourceThreadId: "thread-source",
      connectionFingerprint: "connection-one",
      lastTurnId: "turn-terminal",
    };
    await expectMutation(store, identity, true, {
      kind: "set",
      if: { kind: "absent" },
      binding: supervisionBinding("thread-source", {
        pendingSupervisionBranch: initial,
      }),
    });
    const tracked = { ...initial, cleanupThreadIds: ["thread-probe"] };
    for (const [expected, applied] of [
      [{ ...initial, connectionFingerprint: "connection-two" }, false],
      [{ ...initial, lastTurnId: "turn-other" }, false],
      [initial, true],
    ] as const) {
      await expectMutation(store, identity, applied, {
        kind: "patch-pending-supervision-branch",
        expected,
        pending: tracked,
      });
    }
    for (const [expected, applied] of [
      [initial, false],
      [tracked, true],
    ] as const) {
      await expectMutation(store, identity, applied, {
        kind: "commit-pending-supervision-branch",
        expected,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      });
    }
    expect(store.read(identity)).toEqual(
      supervisionBinding("thread-final", {
        model: "native-model",
        modelProvider: "native-provider",
      }),
    );
  });

  it.each([false, true])("round-trips app policies (repository=%s)", async (repository) => {
    const pluginAppPolicyContext: NonNullable<ThreadBinding["pluginAppPolicyContext"]> = {
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
    if (repository) {
      pluginAppPolicyContext.apps.github = {
        configKey: "security-review@company-tools",
        marketplaceName: "company-tools",
        pluginName: "security-review",
        allowDestructiveActions: true,
        readOnlyTools: {
          read: { enabled: true, approval_mode: "prompt" as const },
          write: { enabled: false },
          stale: { enabled: false },
        },
        destructiveApprovalMode: "ask" as const,
        mcpServerNames: ["github"],
      };
      pluginAppPolicyContext.pluginAppIds["security-review@company-tools"] = ["github"];
    }

    const { store } = createBindingFixture();
    const identity = makeSessionIdentity("session-policy");
    const binding = thread("thread-policy", { cwd: "/repo/company", pluginAppPolicyContext });
    await setBinding(store, identity, binding);
    expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });
    const imported = await importStoredBinding({
      schemaVersion: 2,
      ...binding,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("retains restricted creation attestation and readable legacy rows after SQLite reopen", async () => {
    const { root } = await createSessionFixture("codex-restricted-binding-reopen-");
    const openStore = () => createBindingStore(sqliteState("restricted-reopen", root));
    const legacy = thread("restricted-legacy", { nativeToolPolicyRestricted: true });
    const attested = {
      ...legacy,
      threadId: "restricted-attested",
      restrictedThreadConfigFingerprint: hashFingerprint("creation-policy"),
    };
    const legacyIdentity = { kind: "conversation" as const, bindingId: "restricted-legacy" };
    const attestedIdentity = { kind: "conversation" as const, bindingId: "restricted-attested" };
    const store = openStore();
    await setBinding(store, legacyIdentity, legacy);
    await setBinding(store, attestedIdentity, attested);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const reopened = openStore();
    expect(reopened.read(attestedIdentity)).toEqual(attested);
    expect(reopened.read(legacyIdentity)).toEqual(legacy);
    expect(reopened.read(legacyIdentity)?.restrictedThreadConfigFingerprint).toBeUndefined();
  });

  it("retains cleared legacy conversation provenance after normal tombstones expire", async () => {
    const { state, store } = await createSqliteFixture("app-server-thread-bindings-clear-test");
    const normal = { kind: "conversation" as const, bindingId: "normal" };
    const legacy = { kind: "conversation" as const, bindingId: "legacy-source" };
    for (const identity of [normal, legacy]) {
      await setBinding(store, identity, thread(`thread-${identity.bindingId}`));
      await store.mutate(identity, { kind: "clear" });
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10);
    expect(state.lookup(storeKey(normal))).toBeUndefined();
    expect(state.lookup(storeKey(legacy))).toEqual({ version: 1, state: "cleared" });
  });

  it("isolates identical session ids owned by different agents", async () => {
    const { store } = createBindingFixture();
    const first = makeSessionIdentity("shared", "first");
    const second = makeSessionIdentity("shared", "second");

    await setBinding(store, first, { threadId: "thread-first", cwd: "/first" });
    await setBinding(store, second, { threadId: "thread-second", cwd: "/second" });

    expect(store.read(first)).toMatchObject({ threadId: "thread-first" });
    expect(store.read(second)).toMatchObject({ threadId: "thread-second" });
    expect(storeKey({ kind: "session", agentId: " First ", sessionId: "shared" })).toBe(
      "session:first:shared",
    );
    expect(storeKey(first)).not.toBe(storeKey({ ...first, sessionId: "different" }));
  });

  it("rejects a delayed adoption after a newer session generation wins", async () => {
    const {
      values,
      store,
      previous: first,
      current: second,
    } = await createGenerationFixture("thread-1", "/repo");
    const third = { ...first, sessionId: "session-3" };
    expect(store.read(second)).toBeUndefined();
    await store.withLease(second, async () => undefined);
    expect(storeKey(first)).toBe(storeKey(second));
    const key = storeKey(first);
    expect(values.get(key)).toMatchObject({ sessionId: first.sessionId });
    values.set(key, {
      ...values.get(key)!,
      lease: { token: "crashed-predecessor", expiresAt: Date.now() - 1 },
    });
    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
    const plan = await store.prepareSessionGenerationReclaim(first);
    expect(plan).toEqual({ kind: "verify", expectedPreviousSessionId: second.sessionId });
    await expect(store.adoptSessionGeneration(third, second.sessionId)).resolves.toBe("adopted");
    await expect(store.adoptSessionGeneration(third, second.sessionId)).resolves.toBe("current");
    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("conflict");
    await expect(store.retireSessionGeneration(second)).resolves.toBe("conflict");
    await expectReclaim(store, first, false, second.sessionId);
    await expectMutation(store, second, false, {
      kind: "patch",
      threadId: "thread-1",
      patch: { model: "stale-model" },
    });
    await expect(store.mutate(second, { kind: "clear" })).resolves.toBe(false);

    expect(store.read(second)).toBeUndefined();
    expect(store.read(third)).toMatchObject({ threadId: "thread-1" });
    await expect(store.mutate(third, { kind: "clear" })).resolves.toBe(true);
  });

  it.each(["ordinary", "supervision"] as const)(
    "adopts the committed predecessor after reopening a %s binding without a compaction hook",
    async (ownership) => {
      const { root, storePath } = await createSessionFixture("codex-predecessor-reopen-");
      const previous = makeStableSessionIdentity(
        "session-before-compaction",
        "agent:main:compaction",
      );
      const current = { ...previous, sessionId: "session-after-compaction" };
      const sessionScope = { agentId: current.agentId, sessionKey: current.sessionKey, storePath };
      const binding = {
        ...nativeBinding("native-thread-before-compaction", ownership === "supervision"),
        dynamicToolsFingerprint: hashFingerprint("native-tools"),
      };
      const openStore = () =>
        createLazyCodexAppServerBindingStore(sqliteState("predecessor-reopen", root, true));

      await recordSession(previous, storePath);
      await setBinding(openStore(), previous, binding);
      await patchSessionEntry({
        ...sessionScope,
        update: () => ({ sessionId: current.sessionId }),
      });
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const store = openStore();
      expect(store.read(current)).toBeUndefined();

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(reclaim(store, current, storePath)).resolves.toBe(true);
        expect(store.read(current)).toEqual(binding);
      }
      await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    },
  );

  it.each([
    ["two generations behind", false],
    ["two generations behind", true],
    ["different session key", false],
    ["different agent", false],
  ] as const)(
    "does not adopt a binding owned by %s (supervision=%s)",
    async (mismatch, supervision) => {
      const { storePath } = await createSessionFixture("codex-predecessor-mismatch-");
      const { store } = createBindingFixture();
      const current = makeStableSessionIdentity("session-current", "agent:main:compaction");
      const previous = {
        ...current,
        sessionId: mismatch === "two generations behind" ? "session-oldest" : "session-previous",
        ...(mismatch === "different session key" ? { sessionKey: "agent:main:other" } : {}),
        ...(mismatch === "different agent" ? { agentId: "other" } : {}),
      };
      const binding = nativeBinding("native-thread-foreign-generation", supervision);

      await recordSession(current, storePath, "session-previous");
      await setBinding(store, previous, binding);

      const resolved = await resolveBinding({
        bindingStore: store,
        identity: current,
        storePath,
      });
      using _ = { [Symbol.dispose]: resolved.release };
      expect(resolved.binding).toBeUndefined();
      expect(store.read(previous)).toEqual(binding);
      await expect(reclaim(store, current, storePath)).resolves.toBe(
        mismatch !== "two generations behind" || !supervision,
      );
      expect(store.read(current)).toBeUndefined();
      expect(store.read(previous)).toEqual(
        mismatch === "two generations behind" && !supervision ? undefined : binding,
      );
    },
  );

  it("rechecks predecessor adoption authority after the lazy store resolves", async () => {
    const state = createMemoryState();
    const previous = makeStableSessionIdentity("session-previous", "agent:main:compaction");
    const current = { ...previous, sessionId: "session-current" };
    const binding = thread("native-thread");
    await setBinding(createBindingStore(state), previous, binding);
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

  it("does not create a retirement tombstone for a session without a Codex binding", async () => {
    const { values, store } = createBindingFixture();
    const identity = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");

    await expect(store.retireSessionGeneration(identity)).resolves.toBe("absent");
    expect(values.size).toBe(0);
  });

  it("expires physical-session retirement fences but retains stable-key fences", async () => {
    const { state, store } = await createSqliteFixture(
      "app-server-thread-bindings-retirement-test",
      true,
    );
    const physical = makeSessionIdentity("physical-session");
    const stable = {
      ...physical,
      sessionId: "stable-session",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const retired = { state: "cleared", retired: true };
    for (const identity of [physical, stable]) {
      await setBinding(store, identity, thread(`thread-${identity.sessionId}`));
      await expect(store.retireSessionGeneration(identity)).resolves.toBe("applied");
      expect(state.lookup(storeKey(identity))).toMatchObject(retired);
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60_000);

    expect(state.lookup(storeKey(physical))).toBeUndefined();
    expect(state.lookup(storeKey(stable))).toMatchObject(retired);
  });

  it.each(["active", "cleared", "retired"] as const)(
    "reclaims a %s generation without admitting stale writers",
    async (state) => {
      const { values, store, previous, current } = await createGenerationFixture();
      await expectSet(store, current, false, "thread-premature", "/new", true);
      if (state === "cleared") {
        await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);
        await expectSet(store, current, false, "thread-new", "/new", true);
      } else if (state === "retired") {
        const retired = retiredRow(previous.sessionId);
        await expect(store.retireSessionGeneration(previous)).resolves.toBe("applied");
        await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);
        expect(values.get(storeKey(previous))).toEqual(retired);
        await expectSet(store, previous, false, "thread-stale", "/stale");
        await expect(store.withLease(previous, async () => undefined)).rejects.toThrow(
          "generation was retired",
        );
        await store.withLease(current, async () => undefined);
        expect(values.get(storeKey(previous))).toEqual(retired);
        await expectSet(store, previous, false, "thread-delayed", "/stale");
      } else {
        await expectReclaim(store, current, false, "other-session");
        expect(values.get(storeKey(previous))).toMatchObject({
          state: "active",
          sessionId: previous.sessionId,
        });
      }
      await expectReclaim(store, current, true, previous.sessionId);
      await expectSet(store, previous, false, "thread-delayed-before-commit", "/stale");
      await expectSet(store, current, true, "thread-new", "/new", true);
      expect(store.read(previous)).toBeUndefined();
      expect(store.read(current)).toMatchObject({ threadId: "thread-new", cwd: "/new" });
      await expectReclaim(store, previous, false, previous.sessionId);
      await expectSet(store, previous, false, "thread-delayed", "/stale", true);
      await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    },
  );

  it("preserves a stale private supervision binding instead of reclaiming it as empty", async () => {
    const { store } = createBindingFixture();
    const previous = makeStableSessionIdentity("session-1", "agent:main:telegram:supervised");
    const current = { ...previous, sessionId: "session-2" };
    await setBinding(
      store,
      previous,
      supervisionBinding("thread-supervised", {
        model: "gpt-5.5",
        modelProvider: "openai",
      }),
    );
    await expectSet(store, previous, false, "thread-replacement", "/other");
    await expectMutation(store, previous, false, { kind: "clear", threadId: "thread-supervised" });

    await expectReclaim(store, current, false, previous.sessionId);
    expect(store.read(previous)).toMatchObject({
      threadId: "thread-supervised",
      connectionScope: "supervision",
    });
    expect(store.read(current)).toBeUndefined();
  });

  it("fences a retired in-place generation until the authoritative session store verifies it", async () => {
    const { storePath } = await createSessionFixture("openclaw-codex-reset-reclaim-");
    const { values, store } = createBindingFixture();
    const identity = makeStableSessionIdentity("session-current", "agent:main:telegram:direct:123");

    await recordSession(identity, storePath);
    await setBinding(store, identity, thread("thread-before-reset"));
    await store.retireSessionGeneration(identity);
    await expect(store.resetSessionGeneration(identity)).resolves.toBe("conflict");
    expect(values.get(storeKey(identity))).toEqual(retiredRow(identity.sessionId));
    await expectSet(store, identity, false, "thread-unverified", "/new");
    await expect(reclaim(store, identity, storePath)).resolves.toBe(true);
    await expectSet(store, identity, true, "thread-after-reset", "/repo");
  });

  it("hashes stable session keys and keeps agent ownership distinct", () => {
    const sessionKey = "agent:main:telegram:private-peer@example.com";
    const first = storeKey({ ...makeSessionIdentity("session-1", "first"), sessionKey });
    const second = storeKey({ ...makeSessionIdentity("session-2", "second"), sessionKey });

    expect(first).toMatch(/^session-key:first:[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("private-peer");
    expect(second).not.toBe(first);
  });

  it("patches only the expected thread without advancing history implicitly", async () => {
    const { store } = createBindingFixture();
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    const historyCoveredThrough = "2026-01-01T00:00:00.000Z";
    await setBinding(store, identity, {
      threadId: "thread-1",
      cwd: "/repo",
      model: "gpt-5.4-codex",
      historyCoveredThrough,
    });

    await expectMutation(store, identity, true, {
      kind: "patch",
      threadId: "thread-1",
      patch: { serviceTier: "fast" },
    });
    expect(store.read(identity)).toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      serviceTier: "priority",
      historyCoveredThrough,
    });
  });

  it("rejects empty storage identities", () => {
    expect(() => storeKey({ kind: "session", agentId: "main", sessionId: " " })).toThrow(
      "requires a session id",
    );
    expect(() => storeKey({ kind: "session", agentId: " ", sessionId: "session-1" })).toThrow(
      "requires an agent id",
    );
  });
});
