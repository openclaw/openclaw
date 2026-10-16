import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  getSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
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

const stateDirs: string[] = [];
const sessionFixtures: Awaited<ReturnType<typeof createOpenClawTestState>>[] = [];
async function createSessionFixture(prefix: string) {
  const fixture = await createOpenClawTestState({ prefix, layout: "state-only", applyEnv: false });
  sessionFixtures.push(fixture);
  return { root: fixture.stateDir, storePath: path.join(fixture.stateDir, "sessions.json") };
}
function createSqliteFixture(namespace: string, rejectNew = false) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
  stateDirs.push(stateDir);
  const state = createSqliteState({
    namespace,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    ...(rejectNew ? { overflowPolicy: "reject-new" as const } : {}),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return { state, store: createBindingStore(state) };
}

function makeSessionIdentity(sessionId: string) {
  return { kind: "session" as const, agentId: "main", sessionId };
}

function makeStableSessionIdentity(sessionId: string, sessionKey: string) {
  return { ...makeSessionIdentity(sessionId), sessionKey };
}

function setBinding(store: BindingStore, identity: Identity, binding: ThreadBinding) {
  return store.mutate(identity, { kind: "set", binding });
}

function nativeBinding(threadId: string, supervision: boolean): ThreadBinding {
  return {
    threadId,
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

async function expectPolicyRoundTrip(
  policy: NonNullable<ThreadBinding["pluginAppPolicyContext"]>,
  cwd: string,
  updatedAt?: string,
) {
  const { store } = createBindingFixture();
  const identity = makeSessionIdentity("session-policy");
  const binding = { threadId: "thread-policy", cwd, pluginAppPolicyContext: policy };
  await setBinding(store, identity, binding);
  expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext: policy });
  const imported = await importStoredBinding({ schemaVersion: 2, ...binding, updatedAt });
  expect(imported?.binding.pluginAppPolicyContext).toEqual(policy);
}

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  for (const fixture of sessionFixtures.splice(0)) {
    await fixture.cleanup();
  }
});

describe("Codex app-server binding store", () => {
  it("rechecks resume authority after the lazy store resolves and before writing", async () => {
    const state = createMemoryState();
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

  it("replaces only the exact ordinary thread owner", async () => {
    const { store } = createBindingFixture();
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-cas" };
    await setBinding(store, identity, { threadId: "thread-old", cwd: "/repo" });

    await expectMutation(store, identity, false, {
      kind: "replace-thread",
      expectedThreadId: "thread-stale",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });
    expect(store.read(identity)).toMatchObject({ threadId: "thread-old" });

    await expectMutation(store, identity, true, {
      kind: "replace-thread",
      expectedThreadId: "thread-old",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });
    expect(store.read(identity)).toMatchObject({ threadId: "thread-new" });
  });

  it("rejects same-thread and supervision ownership through replacement CAS", async () => {
    const { store } = createBindingFixture();
    const identity = makeSessionIdentity("session-cas-boundary");
    await setBinding(store, identity, { threadId: "thread-old", cwd: "/repo" });

    await expectMutation(store, identity, false, {
      kind: "replace-thread",
      expectedThreadId: "thread-old",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });
    await expectMutation(store, identity, false, {
      kind: "replace-thread",
      expectedThreadId: "thread-old",
      binding: {
        threadId: "thread-private",
        cwd: "/repo",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-private",
        preserveNativeModel: true,
      },
    });
    expect(store.read(identity)).toMatchObject({ threadId: "thread-old" });
  });

  it("does not report the exact session or conversation binding owner as another owner", async () => {
    const { store } = createBindingFixture();
    const sessionIdentity = makeSessionIdentity("session-current");
    await setBinding(store, sessionIdentity, { threadId: "thread-session", cwd: "/repo" });

    await expect(store.hasOtherThreadOwner("thread-session", sessionIdentity)).resolves.toBe(false);

    const conversationIdentity = { kind: "conversation" as const, bindingId: "conversation-1" };
    await setBinding(store, conversationIdentity, {
      threadId: "thread-conversation",
      cwd: "/repo",
    });
    await expect(
      store.hasOtherThreadOwner("thread-conversation", conversationIdentity),
    ).resolves.toBe(false);
  });

  it("reports a different valid active binding owner", async () => {
    const { store } = createBindingFixture();
    const currentIdentity = makeSessionIdentity("session-current");
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
    const { values, store } = createBindingFixture();
    const currentIdentity = makeStableSessionIdentity("session-current", "agent:main:stable");
    values.set(storeKey(currentIdentity), {
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
    const { values, store } = createBindingFixture();
    const currentIdentity = makeSessionIdentity("session-current");
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
    const { values, store } = createBindingFixture();
    const currentIdentity = makeSessionIdentity("session-current");
    values.set("conversation:cleared", {
      version: 1,
      state: "cleared",
      retired: true,
      binding: { threadId: "thread-unowned", cwd: "/repo" },
    } as never);

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).resolves.toBe(false);
  });

  it("fails closed on malformed pending supervision state", async () => {
    const base = { threadId: "thread-source", cwd: "/repo" };
    const pending = { sourceThreadId: "thread-source" };
    for (const binding of [
      {
        ...base,
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          ...pending,
          cleanupThreadIds: ["thread-probe", "thread-probe"],
        },
      },
      {
        ...base,
        threadId: "thread-other",
        preserveNativeModel: true,
        pendingSupervisionBranch: pending,
      },
      { ...base, pendingSupervisionBranch: { ...pending, unknown: true } },
    ]) {
      expect(decodeBinding(binding)).toBeUndefined();
    }

    const { state, store } = createBindingFixture();
    const identity = makeSessionIdentity("session-corrupt");
    state.register(storeKey(identity), {
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
      binding: {
        threadId: "thread-source",
        cwd: "/repo",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-source",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        pendingSupervisionBranch: initial,
      },
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

    await expectPolicyRoundTrip(pluginAppPolicyContext, "/repo", "2026-01-01T00:00:00.000Z");
  });

  it("round-trips repository marketplace app ownership through stored and imported bindings", async () => {
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

    await expectPolicyRoundTrip(pluginAppPolicyContext, "/repo/company");
  });

  it("retains restricted creation attestation and readable legacy rows after SQLite reopen", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "codex-restricted-binding-reopen-",
      layout: "state-only",
      applyEnv: false,
    });
    const openStore = () =>
      createBindingStore(
        createSqliteState({
          namespace: "restricted-reopen",
          maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
          env: { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir },
        }),
      );
    const legacy = {
      threadId: "restricted-legacy",
      cwd: "/repo",
      nativeToolPolicyRestricted: true as const,
    };
    const attested = {
      ...legacy,
      threadId: "restricted-attested",
      restrictedThreadConfigFingerprint: hashFingerprint("creation-policy"),
    };
    const legacyIdentity = { kind: "conversation" as const, bindingId: "restricted-legacy" };
    const attestedIdentity = { kind: "conversation" as const, bindingId: "restricted-attested" };
    try {
      const store = openStore();
      await store.mutate(legacyIdentity, { kind: "set", binding: legacy });
      await store.mutate(attestedIdentity, { kind: "set", binding: attested });
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const reopened = openStore();
      expect(reopened.read(attestedIdentity)).toEqual(attested);
      expect(reopened.read(legacyIdentity)).toEqual(legacy);
      expect(reopened.read(legacyIdentity)?.restrictedThreadConfigFingerprint).toBeUndefined();
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      await fixture.cleanup();
    }
  });

  it("retains cleared legacy conversation provenance after normal tombstones expire", async () => {
    const { state, store } = createSqliteFixture("app-server-thread-bindings-clear-test");
    const normal = { kind: "conversation" as const, bindingId: "normal" };
    const legacy = { kind: "conversation" as const, bindingId: "legacy-source" };
    for (const identity of [normal, legacy]) {
      await setBinding(store, identity, {
        threadId: `thread-${identity.bindingId}`,
        cwd: "/repo",
      });
      await store.mutate(identity, { kind: "clear" });
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10);
    expect(state.lookup(storeKey(normal))).toBeUndefined();
    expect(state.lookup(storeKey(legacy))).toEqual({ version: 1, state: "cleared" });
  });

  it("isolates identical session ids owned by different agents", async () => {
    const { store } = createBindingFixture();
    const first = { kind: "session" as const, agentId: "first", sessionId: "shared" };
    const second = { kind: "session" as const, agentId: "second", sessionId: "shared" };

    await setBinding(store, first, { threadId: "thread-first", cwd: "/first" });
    await setBinding(store, second, { threadId: "thread-second", cwd: "/second" });

    expect(store.read(first)).toMatchObject({ threadId: "thread-first" });
    expect(store.read(second)).toMatchObject({ threadId: "thread-second" });
    expect(storeKey({ kind: "session", agentId: " First ", sessionId: "shared" })).toBe(
      "session:first:shared",
    );
  });

  it.each([false, true])(
    "keeps one binding across session rotations (expired lease=%s)",
    async (expiredLease) => {
      const {
        values,
        store,
        previous: first,
        current: second,
      } = await createGenerationFixture("thread-1", "/repo");
      expect(store.read(second)).toBeUndefined();
      await store.withLease(second, async () => undefined);

      expect(storeKey(first)).toBe(storeKey(second));
      expect(values.size).toBe(1);
      expect(values.get(storeKey(second))).toMatchObject({ sessionId: "session-1" });
      if (expiredLease) {
        const key = storeKey(first);
        const predecessor = values.get(key)!;
        values.set(key, {
          ...predecessor,
          lease: { token: "crashed-predecessor", expiresAt: Date.now() - 1 },
        });
      }
      await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
      expect(values.get(storeKey(second))).toMatchObject({
        state: "active",
        sessionId: "session-2",
        binding: { threadId: "thread-1" },
      });
      await expectMutation(store, first, false, {
        kind: "patch",
        threadId: "thread-1",
        patch: { model: "stale-model" },
      });
      await expect(store.mutate(first, { kind: "clear" })).resolves.toBe(false);
      expect(store.read(second)).toMatchObject({ threadId: "thread-1" });
      await expect(store.mutate(second, { kind: "clear" })).resolves.toBe(true);
    },
  );

  it("rejects a delayed adoption after a newer session generation wins", async () => {
    const {
      store,
      previous: first,
      current: second,
    } = await createGenerationFixture("thread-1", "/repo");
    const third = { ...first, sessionId: "session-3" };

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
      const openStore = () => {
        const state = createSqliteState({
          namespace: "predecessor-reopen",
          maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: { ...process.env, OPENCLAW_STATE_DIR: root },
        });
        return { state, store: createLazyCodexAppServerBindingStore(state) };
      };

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
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const { state, store } = openStore();
      expect(store.read(current)).toBeUndefined();

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          reclaimGeneration({
            bindingStore: store,
            identity: current,
            storePath,
          }),
        ).resolves.toBe(true);
        expect(store.read(current)).toEqual(binding);
      }
      expect(state.lookup(storeKey(current))).toEqual({
        version: 1,
        state: "active",
        sessionId: current.sessionId,
        binding,
      });
      await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    },
  );

  it.each(
    ["two generations behind", "different session key", "different agent"].flatMap((mismatch) =>
      [false, true].map((supervision) => ({ mismatch, supervision })),
    ),
  )(
    "does not adopt a binding owned by $mismatch (supervision=$supervision)",
    async ({ mismatch, supervision }) => {
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

      const resolved = await resolveBinding({
        bindingStore: store,
        identity: current,
        storePath,
      });
      using _ = { [Symbol.dispose]: resolved.release };
      expect(resolved.binding).toBeUndefined();
      expect(store.read(previous)).toEqual(binding);
      await expect(
        reclaimGeneration({
          bindingStore: store,
          identity: current,
          storePath,
        }),
      ).resolves.toBe(mismatch !== "two generations behind" || !supervision);
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
    const binding = { threadId: "native-thread", cwd: "/repo" };
    await createBindingStore(state).mutate(previous, { kind: "set", binding });
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
    const {
      store,
      previous: first,
      current: second,
    } = await createGenerationFixture("thread-1", "/repo");
    const third = { ...first, sessionId: "session-3" };

    const plan = await store.prepareSessionGenerationReclaim(second);
    expect(plan).toEqual({ kind: "verify", expectedPreviousSessionId: first.sessionId });
    await expect(store.adoptSessionGeneration(third, first.sessionId)).resolves.toBe("adopted");
    if (plan.kind !== "verify") {
      throw new Error("expected stale session generation");
    }
    await expectReclaim(store, second, false, plan.expectedPreviousSessionId);
    expect(store.read(third)).toMatchObject({ threadId: "thread-1" });
  });

  it("falls back to physical session identity when no stable session key exists", () => {
    const first = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    const second = { ...first, sessionId: "session-2" };

    expect(storeKey(first)).not.toBe(storeKey(second));
  });

  it("does not create a retirement tombstone for a session without a Codex binding", async () => {
    const { values, store } = createBindingFixture();
    const identity = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");

    await expect(store.retireSessionGeneration(identity)).resolves.toBe("absent");
    expect(values.size).toBe(0);
  });

  it("expires physical-session retirement fences but retains stable-key fences", async () => {
    const { state, store } = createSqliteFixture(
      "app-server-thread-bindings-retirement-test",
      true,
    );
    const physical = makeSessionIdentity("physical-session");
    const stable = {
      ...physical,
      sessionId: "stable-session",
      sessionKey: "agent:main:telegram:chat-1",
    };
    for (const identity of [physical, stable]) {
      await setBinding(store, identity, {
        threadId: `thread-${identity.sessionId}`,
        cwd: "/repo",
      });
      await expect(store.retireSessionGeneration(identity)).resolves.toBe("applied");
    }

    expect(state.lookup(storeKey(physical))).toMatchObject({
      state: "cleared",
      retired: true,
    });
    expect(state.lookup(storeKey(stable))).toMatchObject({
      state: "cleared",
      retired: true,
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60_000);

    expect(state.lookup(storeKey(physical))).toBeUndefined();
    expect(state.lookup(storeKey(stable))).toMatchObject({
      state: "cleared",
      retired: true,
    });
  });

  it("claims a cleared binding once without allowing the retired generation back in", async () => {
    const { values, store, previous, current } = await createGenerationFixture();
    await expectSet(store, current, false, "thread-premature", "/new", true);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);

    await expectSet(store, current, false, "thread-new", "/new", true);
    await expectReclaim(store, current, true, previous.sessionId);
    await expectSet(store, current, true, "thread-new", "/new", true);

    expect(store.read(previous)).toBeUndefined();
    expect(store.read(current)).toMatchObject({
      threadId: "thread-new",
      cwd: "/new",
    });
    await expectSet(store, previous, false, "thread-stale", "/stale", true);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    expect(values.size).toBe(1);
  });

  it("reclaims a stale stable generation only for the current OpenClaw session", async () => {
    const { values, store, previous, current } = await createGenerationFixture();
    await expectReclaim(store, current, false, "other-session");
    expect(values.get(storeKey(previous))).toMatchObject({
      state: "active",
      sessionId: "session-1",
    });

    await expectReclaim(store, current, true, previous.sessionId);
    expect(values.get(storeKey(current))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: "session-2",
    });
    await expectSet(store, previous, false, "thread-delayed-before-commit", "/stale");
    await expectSet(store, current, true, "thread-new", "/new", true);

    await expectReclaim(store, previous, false, previous.sessionId);
    await expectSet(store, previous, false, "thread-delayed", "/stale");
    expect(store.read(current)).toMatchObject({ threadId: "thread-new" });
  });

  it("preserves a stale private supervision binding instead of reclaiming it as empty", async () => {
    const { values, store } = createBindingFixture();
    const previous = makeStableSessionIdentity("session-1", "agent:main:telegram:supervised");
    const current = { ...previous, sessionId: "session-2" };
    await setBinding(store, previous, {
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      cwd: "/repo",
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    await expectSet(store, previous, false, "thread-replacement", "/other");
    await expectMutation(store, previous, false, { kind: "clear", threadId: "thread-supervised" });

    await expectReclaim(store, current, false, previous.sessionId);
    expect(values.get(storeKey(previous))).toMatchObject({
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
    const { values, store, previous, current } = await createGenerationFixture();
    const retired = { version: 1, state: "cleared", retired: true, sessionId: "session-1" };

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

    await expectReclaim(store, current, true, previous.sessionId);
    await expectSet(store, current, true, "thread-new", "/new");
    expect(store.read(current)).toMatchObject({ threadId: "thread-new" });
  });

  it("keeps a retired in-place generation fenced until it is verified", async () => {
    const { values, store, previous: identity } = await createGenerationFixture();
    await store.retireSessionGeneration(identity);

    await expect(store.resetSessionGeneration(identity)).resolves.toBe("conflict");
    expect(values.get(storeKey(identity))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: identity.sessionId,
    });
    await expectSet(store, identity, false, "thread-unverified", "/new");
  });

  it("recovers a retired in-place generation through the authoritative session store", async () => {
    const { storePath } = await createSessionFixture("openclaw-codex-reset-reclaim-");
    const { store } = createBindingFixture();
    const identity = makeStableSessionIdentity("session-current", "agent:main:telegram:direct:123");

    await upsertSessionEntry({
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      storePath,
      entry: { sessionId: identity.sessionId, updatedAt: 1 },
    });
    await setBinding(store, identity, { threadId: "thread-before-reset", cwd: "/repo" });
    await store.retireSessionGeneration(identity);

    await expect(
      reclaimGeneration({
        bindingStore: store,
        identity,
        config: { session: { store: storePath } },
      }),
    ).resolves.toBe(true);
    await expectSet(store, identity, true, "thread-after-reset", "/repo");
  });

  it("hashes stable session keys and keeps agent ownership distinct", () => {
    const sessionKey = "agent:main:telegram:private-peer@example.com";
    const first = storeKey({
      kind: "session",
      agentId: "first",
      sessionId: "session-1",
      sessionKey,
    });
    const second = storeKey({
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
