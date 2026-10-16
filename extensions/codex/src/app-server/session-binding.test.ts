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
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerThreadBinding,
  reclaimCurrentCodexSessionGeneration,
  resolveCodexSessionBinding,
  type StoredCodexAppServerBinding,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

function createStateStore() {
  const values = new Map<string, StoredCodexAppServerBinding>();
  const state = createCodexTestBindingStateStore(values);
  return { state, values };
}

function createBindingFixture() {
  const fixture = createStateStore();
  return { ...fixture, store: createCodexAppServerBindingStore(fixture.state) };
}

function makeSessionIdentity(sessionId: string) {
  return { kind: "session" as const, agentId: "main", sessionId };
}

function makeStableSessionIdentity(sessionId: string, sessionKey: string) {
  return { ...makeSessionIdentity(sessionId), sessionKey };
}

function setBinding(
  store: CodexAppServerBindingStore,
  identity: Parameters<CodexAppServerBindingStore["mutate"]>[0],
  binding: CodexAppServerThreadBinding,
) {
  return store.mutate(identity, { kind: "set", binding });
}

async function expectMutation(
  store: CodexAppServerBindingStore,
  identity: Parameters<CodexAppServerBindingStore["mutate"]>[0],
  expected: boolean,
  mutation: Parameters<CodexAppServerBindingStore["mutate"]>[1],
) {
  await expect(store.mutate(identity, mutation)).resolves.toBe(expected);
}

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
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

    const { state, store } = createBindingFixture();
    const identity = makeSessionIdentity("session-corrupt");
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
    await expectMutation(store, identity, false, {
      kind: "patch-pending-supervision-branch",
      expected: { ...initial, connectionFingerprint: "connection-two" },
      pending: tracked,
    });
    await expectMutation(store, identity, false, {
      kind: "patch-pending-supervision-branch",
      expected: { ...initial, lastTurnId: "turn-other" },
      pending: tracked,
    });
    await expectMutation(store, identity, true, {
      kind: "patch-pending-supervision-branch",
      expected: initial,
      pending: tracked,
    });
    await expectMutation(store, identity, false, {
      kind: "commit-pending-supervision-branch",
      expected: initial,
      threadId: "thread-final",
      patch: { model: "native-model", modelProvider: "native-provider" },
    });
    await expectMutation(store, identity, true, {
      kind: "commit-pending-supervision-branch",
      expected: tracked,
      threadId: "thread-final",
      patch: { model: "native-model", modelProvider: "native-provider" },
    });
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
    const { store } = createBindingFixture();
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

    await setBinding(store, identity, {
      threadId: "thread-account",
      cwd: "/repo",
      pluginAppPolicyContext,
    });
    expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

    const imported = await createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-account",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("round-trips repository marketplace app ownership through stored and imported bindings", async () => {
    const { store } = createBindingFixture();
    const identity = makeSessionIdentity("session-security-review");
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

    await setBinding(store, identity, {
      threadId: "thread-security-review",
      cwd: "/repo/company",
      pluginAppPolicyContext,
    });
    expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

    const imported = await createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-security-review",
      cwd: "/repo/company",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("retains cleared legacy conversation provenance after normal tombstones expire", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createCodexSqliteTestBindingStateStore({
        namespace: "app-server-thread-bindings-clear-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
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
      expect(state.lookup(bindingStoreKey(normal))).toBeUndefined();
      expect(state.lookup(bindingStoreKey(legacy))).toEqual({ version: 1, state: "cleared" });
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("isolates identical session ids owned by different agents", async () => {
    const { store } = createBindingFixture();
    const first = { kind: "session" as const, agentId: "first", sessionId: "shared" };
    const second = { kind: "session" as const, agentId: "second", sessionId: "shared" };

    await setBinding(store, first, { threadId: "thread-first", cwd: "/first" });
    await setBinding(store, second, { threadId: "thread-second", cwd: "/second" });

    expect(store.read(first)).toMatchObject({ threadId: "thread-first" });
    expect(store.read(second)).toMatchObject({ threadId: "thread-second" });
    expect(bindingStoreKey({ kind: "session", agentId: " First ", sessionId: "shared" })).toBe(
      "session:first:shared",
    );
  });

  it.each([false, true])(
    "keeps one binding across session rotations (expired lease=%s)",
    async (expiredLease) => {
      const { values, store } = createBindingFixture();
      const first = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");
      const second = { ...first, sessionId: "session-2" };

      await setBinding(store, first, { threadId: "thread-1", cwd: "/repo" });
      expect(store.read(second)).toBeUndefined();
      await store.withLease(second, async () => undefined);

      expect(bindingStoreKey(first)).toBe(bindingStoreKey(second));
      expect(values.size).toBe(1);
      expect(values.get(bindingStoreKey(second))).toMatchObject({ sessionId: "session-1" });
      if (expiredLease) {
        const key = bindingStoreKey(first);
        const predecessor = values.get(key)!;
        values.set(key, {
          ...predecessor,
          lease: { token: "crashed-predecessor", expiresAt: Date.now() - 1 },
        });
      }
      await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
      expect(values.get(bindingStoreKey(second))).toMatchObject({
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
    const { store } = createBindingFixture();
    const first = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await setBinding(store, first, { threadId: "thread-1", cwd: "/repo" });

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
      const previous = makeStableSessionIdentity(
        "session-before-compaction",
        "agent:main:compaction",
      );
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
        const state = createCodexSqliteTestBindingStateStore({
          namespace: "predecessor-reopen",
          maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: { ...process.env, OPENCLAW_STATE_DIR: root },
        });
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
        await closeOpenClawStateDatabaseAsync();
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
        await closeOpenClawStateDatabaseAsync();
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
      const { store } = createBindingFixture();
      const current = makeStableSessionIdentity("session-current", "agent:main:compaction");
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

        const resolved = await resolveCodexSessionBinding({
          bindingStore: store,
          identity: current,
          storePath,
        });
        using _ = { [Symbol.dispose]: resolved.release };
        expect(resolved.binding).toBeUndefined();
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
    const previous = makeStableSessionIdentity("session-previous", "agent:main:compaction");
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
    const { store } = createBindingFixture();
    const first = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await setBinding(store, first, { threadId: "thread-1", cwd: "/repo" });

    const plan = await store.prepareSessionGenerationReclaim(second);
    expect(plan).toEqual({ kind: "verify", expectedPreviousSessionId: first.sessionId });
    await expect(store.adoptSessionGeneration(third, first.sessionId)).resolves.toBe("adopted");
    if (plan.kind !== "verify") {
      throw new Error("expected stale session generation");
    }
    await expectMutation(store, second, false, {
      kind: "reclaim-generation",
      expectedPreviousSessionId: plan.expectedPreviousSessionId,
    });
    expect(store.read(third)).toMatchObject({ threadId: "thread-1" });
  });

  it("falls back to physical session identity when no stable session key exists", () => {
    const first = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    const second = { ...first, sessionId: "session-2" };

    expect(bindingStoreKey(first)).not.toBe(bindingStoreKey(second));
  });

  it("does not create a retirement tombstone for a session without a Codex binding", async () => {
    const { values, store } = createBindingFixture();
    const identity = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");

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
    const { values, store } = createBindingFixture();
    const previous = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");
    const current = { ...previous, sessionId: "session-2" };
    await setBinding(store, previous, { threadId: "thread-old", cwd: "/old" });
    await expectMutation(store, current, false, {
      kind: "set",
      binding: { threadId: "thread-premature", cwd: "/new" },
      if: { kind: "absent" },
    });
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);

    await expectMutation(store, current, false, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/new" },
      if: { kind: "absent" },
    });
    await expectMutation(store, current, true, {
      kind: "reclaim-generation",
      expectedPreviousSessionId: previous.sessionId,
    });
    await expectMutation(store, current, true, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/new" },
      if: { kind: "absent" },
    });

    expect(store.read(previous)).toBeUndefined();
    expect(store.read(current)).toMatchObject({
      threadId: "thread-new",
      cwd: "/new",
    });
    await expectMutation(store, previous, false, {
      kind: "set",
      binding: { threadId: "thread-stale", cwd: "/stale" },
      if: { kind: "absent" },
    });
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    expect(values.size).toBe(1);
  });

  it("reclaims a stale stable generation only for the current OpenClaw session", async () => {
    const { values, store } = createBindingFixture();
    const previous = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");
    const current = { ...previous, sessionId: "session-2" };
    await setBinding(store, previous, { threadId: "thread-old", cwd: "/old" });
    await expectMutation(store, current, false, {
      kind: "reclaim-generation",
      expectedPreviousSessionId: "other-session",
    });
    expect(values.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: "session-1",
    });

    await expectMutation(store, current, true, {
      kind: "reclaim-generation",
      expectedPreviousSessionId: previous.sessionId,
    });
    expect(values.get(bindingStoreKey(current))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: "session-2",
    });
    await expectMutation(store, previous, false, {
      kind: "set",
      binding: { threadId: "thread-delayed-before-commit", cwd: "/stale" },
    });
    await expectMutation(store, current, true, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/new" },
      if: { kind: "absent" },
    });

    await expectMutation(store, previous, false, {
      kind: "reclaim-generation",
      expectedPreviousSessionId: previous.sessionId,
    });
    await expectMutation(store, previous, false, {
      kind: "set",
      binding: { threadId: "thread-delayed", cwd: "/stale" },
    });
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
    await expectMutation(store, previous, false, {
      kind: "set",
      binding: { threadId: "thread-replacement", cwd: "/other" },
    });
    await expectMutation(store, previous, false, { kind: "clear", threadId: "thread-supervised" });

    await expectMutation(store, current, false, {
      kind: "reclaim-generation",
      expectedPreviousSessionId: previous.sessionId,
    });
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
    const { values, store } = createBindingFixture();
    const previous = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");
    const current = { ...previous, sessionId: "session-2" };
    await setBinding(store, previous, { threadId: "thread-old", cwd: "/old" });

    await expect(store.retireSessionGeneration(previous)).resolves.toBe("applied");
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);
    expect(values.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expectMutation(store, previous, false, {
      kind: "set",
      binding: { threadId: "thread-stale", cwd: "/stale" },
    });
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
    await expectMutation(store, previous, false, {
      kind: "set",
      binding: { threadId: "thread-delayed", cwd: "/stale" },
    });

    await expectMutation(store, current, true, {
      kind: "reclaim-generation",
      expectedPreviousSessionId: previous.sessionId,
    });
    await expectMutation(store, current, true, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/new" },
    });
    expect(store.read(current)).toMatchObject({ threadId: "thread-new" });
  });

  it("keeps a retired in-place generation fenced until it is verified", async () => {
    const { values, store } = createBindingFixture();
    const identity = makeStableSessionIdentity("session-1", "agent:main:telegram:chat-1");
    await setBinding(store, identity, { threadId: "thread-old", cwd: "/old" });
    await store.retireSessionGeneration(identity);

    await expect(store.resetSessionGeneration(identity)).resolves.toBe("conflict");
    expect(values.get(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: identity.sessionId,
    });
    await expectMutation(store, identity, false, {
      kind: "set",
      binding: { threadId: "thread-unverified", cwd: "/new" },
    });
  });

  it("recovers a retired in-place generation through the authoritative session store", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "openclaw-codex-reset-reclaim-",
      layout: "state-only",
      applyEnv: false,
    });
    const root = fixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const { store } = createBindingFixture();
    const identity = makeStableSessionIdentity("session-current", "agent:main:telegram:direct:123");
    try {
      await upsertSessionEntry({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        storePath,
        entry: { sessionId: identity.sessionId, updatedAt: 1 },
      });
      await setBinding(store, identity, { threadId: "thread-before-reset", cwd: "/repo" });
      await store.retireSessionGeneration(identity);

      await expect(
        reclaimCurrentCodexSessionGeneration({
          bindingStore: store,
          identity,
          config: { session: { store: storePath } },
        }),
      ).resolves.toBe(true);
      await expectMutation(store, identity, true, {
        kind: "set",
        binding: { threadId: "thread-after-reset", cwd: "/repo" },
      });
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
    expect(() => bindingStoreKey({ kind: "session", agentId: "main", sessionId: " " })).toThrow(
      "requires a session id",
    );
    expect(() =>
      bindingStoreKey({ kind: "session", agentId: " ", sessionId: "session-1" }),
    ).toThrow("requires an agent id");
  });
});
