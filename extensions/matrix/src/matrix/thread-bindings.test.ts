import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateActionAuthority,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { getSessionBindingService, testing } from "openclaw/plugin-sdk/session-binding-runtime";
import { SqliteWorkerError } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { getMatrixRuntime, setMatrixRuntime } from "../runtime.js";
import {
  resolveMatrixStateFilePath,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./client/storage.js";
import {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
  type MatrixThreadBindingManagerV2,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";
import { createMatrixThreadBindingManager } from "./thread-bindings.js";

function interceptStore(
  decorate: <T>(store: PluginStateKeyedStore<T, 2>) => PluginStateKeyedStore<T, 2>,
  bindingsOnly = true,
) {
  const state = getMatrixRuntime().state;
  const openStore = state.openKeyedStoreV2;
  const replacement = <T>(
    options: OpenAsyncKeyedStoreOptions,
    authority?: PluginStateActionAuthority,
  ) => {
    const store = openStore<T>(options, authority);
    return !bindingsOnly || options.namespace === "thread-bindings" ? decorate(store) : store;
  };
  return vi.spyOn(state, "openKeyedStoreV2").mockImplementation(replacement);
}

function pauseNextWrite(bindingsOnly = true) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const hold = async () => {
    if (held) {
      return;
    }
    held = true;
    entered.resolve();
    await release.promise;
  };
  const open = interceptStore(
    (store) => ({
      ...store,
      register: async (...args) => {
        await hold();
        return await store.register(...args);
      },
      delete: bindingsOnly
        ? async (...args) => {
            await hold();
            return await store.delete(...args);
          }
        : store.delete,
    }),
    bindingsOnly,
  );
  return { entered: entered.promise, release: release.resolve, restore: () => open.mockRestore() };
}

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (_to: string, _message: string, opts?: { threadId?: string }) => ({
    messageId: opts?.threadId ? "$reply" : "$root",
    roomId: "!room:example",
  })),
);
vi.mock("./send.js", () => ({ sendMessageMatrix: sendMessageMatrixMock }));

describe("matrix thread bindings", () => {
  let stateDir: string;
  const service = getSessionBindingService();
  const auth = {
    accountId: "ops",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
  } as const;
  const accountId = "ops";
  const targetSessionKey = "agent:ops:subagent:child";
  const idleTimeoutMs = 24 * 60 * 60 * 1000;
  const matrixClient = {} as never;
  const trackedManagers = new Set<MatrixThreadBindingManagerV2>();

  async function resetThreadBindingAdapters() {
    await Promise.all([...trackedManagers].map((manager) => manager.stop()));
    trackedManagers.clear();
    testing.resetSessionBindingAdaptersForTests();
  }

  function currentThreadConversation(
    conversationId = "$thread",
    parentConversationId = "!room:example",
  ) {
    return {
      channel: "matrix" as const,
      accountId,
      conversationId,
      parentConversationId,
    };
  }
  const thread = currentThreadConversation();

  type Conversation = Parameters<typeof service.inspectByConversationAsync>[0];
  async function expectAvailable(binding: unknown, conversation: Conversation = thread) {
    expect(await service.inspectByConversationAsync(conversation)).toMatchObject({
      status: "available",
      binding,
    });
  }

  async function createBindingManager(
    params: Partial<
      Omit<Parameters<typeof createMatrixThreadBindingManager>[0], "accountId" | "client">
    > = {},
  ) {
    const manager = await createMatrixThreadBindingManager({
      cfg: {},
      accountId,
      auth,
      client: matrixClient,
      idleTimeoutMs,
      maxAgeMs: 0,
      enableSweeper: false,
      ...params,
    });
    trackedManagers.add(manager);
    return manager;
  }

  async function bindCurrentThread(
    params: {
      targetSessionKey?: string;
      conversationId?: string;
      parentConversationId?: string;
      metadata?: { introText?: string };
    } = {},
  ) {
    return service.bind({
      targetSessionKey: params.targetSessionKey ?? targetSessionKey,
      targetKind: "subagent",
      conversation: currentThreadConversation(params.conversationId, params.parentConversationId),
      placement: "current",
      metadata: params.metadata,
    });
  }

  async function resolveBindingsFilePath(customStateDir?: string) {
    return await resolveMatrixStateFilePath({
      auth,
      env: process.env,
      stateDir: customStateDir,
      filename: "thread-bindings.json",
    });
  }

  async function readPersistedLastActivityAt(bindingsPath: string) {
    return (await readPersistedBindings(bindingsPath))[0]?.lastActivityAt;
  }

  type StoredBinding = Partial<MatrixThreadBindingRecord>;
  function openStoredBindings<T = StoredBinding>(bindingsPath: string) {
    return createPluginStateKeyedStoreForTests<T>("matrix", {
      namespace: "thread-bindings",
      maxEntries: 10_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.dirname(bindingsPath) },
    });
  }

  async function readPersistedBindings(bindingsPath?: string) {
    const store = openStoredBindings(bindingsPath ?? (await resolveBindingsFilePath()));
    return (await store.entries())
      .map((entry) => entry.value)
      .filter((entry) => entry.accountId === accountId)
      .toSorted((a, b) => (a.boundAt ?? 0) - (b.boundAt ?? 0));
  }

  async function expectPersistedThreadBinding(
    bindingsPath: string,
    conversationId = "$thread",
    sessionKey = targetSessionKey,
  ) {
    const persisted = await readPersistedBindings(bindingsPath);
    expect(persisted).toMatchObject([
      {
        conversationId,
        targetSessionKey: sessionKey,
        parentConversationId: "!room:example",
      },
    ]);
  }

  beforeEach(async () => {
    stateDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "matrix-thread-bindings-"));
    await resetThreadBindingAdapters();
    resetPluginStateStoreForTests();
    sendMessageMatrixMock.mockClear();
    setMatrixRuntime({
      state: {
        openKeyedStoreV2: (options: OpenKeyedStoreOptions, authority) =>
          createPluginStateKeyedStoreV2ForTests(
            "matrix",
            options,
            authority ?? { assertCurrent() {} },
          ),
        openKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests("matrix", options),
        openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateSyncKeyedStoreForTests("matrix", options),
        resolveStateDir: () => stateDir,
      },
    } as PluginRuntime);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetThreadBindingAdapters();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it("loads and updates thread bindings written by the July SQLite store", async () => {
    const bindingsPath = await resolveBindingsFilePath();
    const store = openStoredBindings(bindingsPath);
    // v2026.7.1: account id plus sha256(account id, parent room, thread), NUL-separated.
    const key = "ops:df4863925b4d3d0c82df25928e615588bf4a6bd9544af82cf52100573eba9b8b";
    const stored = {
      accountId,
      conversationId: "$thread",
      parentConversationId: "!room:example",
      targetKind: "subagent",
      targetSessionKey,
      agentId: "ops",
      boundBy: "system",
      boundAt: 1_783_944_000_000,
      lastActivityAt: 1_783_944_000_000,
      idleTimeoutMs,
      maxAgeMs: 0,
    } satisfies MatrixThreadBindingRecord;
    await store.register(key, stored);

    const manager = await createBindingManager();
    const binding = service.resolveByConversation(thread);
    expect(binding).toMatchObject({
      targetSessionKey: stored.targetSessionKey,
      boundAt: stored.boundAt,
    });
    if (!binding) {
      throw new Error("expected July Matrix thread binding");
    }
    service.touch(binding.bindingId, stored.lastActivityAt + 1_000);
    await manager.stop();

    expect((await store.entries()).map((entry) => entry.key)).toEqual([key]);
    await expect(store.lookup(key)).resolves.toMatchObject({
      ...stored,
      lastActivityAt: stored.lastActivityAt + 1_000,
    });
    expect(fsSync.existsSync(bindingsPath)).toBe(false);
  });

  it("refuses retired thread-binding JSON without importing or deleting it", async () => {
    const bindingsPath = await resolveBindingsFilePath();
    const source = JSON.stringify({
      version: 1,
      bindings: [{ conversationId: "$thread", targetSessionKey }],
    });
    await fs.mkdir(path.dirname(bindingsPath), { recursive: true });
    await fs.writeFile(bindingsPath, source);

    await expect(createBindingManager()).rejects.toThrow(/2026\.9\.5/);

    expect(await fs.readFile(bindingsPath, "utf8")).toBe(source);
    expect(fsSync.existsSync(path.join(path.dirname(bindingsPath), "state"))).toBe(false);
    expect(service.resolveByConversation(thread)).toBeNull();
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
  });

  it.each(["child", "current"] as const)("posts an intro with %s placement", async (placement) => {
    const current = placement === "current";
    const cfg = current ? { agents: { entries: { main: {}, molty: {} } } } : {};
    const sessionKey = current ? "agent:molty:subagent:child" : targetSessionKey;
    const introText = current ? "intro thread" : "intro root";
    await createBindingManager({ cfg });
    const binding = await service.bind({
      targetSessionKey: sessionKey,
      targetKind: "subagent",
      conversation: current
        ? thread
        : { channel: "matrix", accountId, conversationId: "!room:example" },
      placement,
      metadata: { introText },
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledWith("room:!room:example", introText, {
      cfg,
      client: matrixClient,
      accountId,
      ...(current ? { threadId: "$thread" } : {}),
    });
    expect(binding.conversation).toEqual(current ? thread : currentThreadConversation("$root"));
    if (current) {
      expect(service.resolveByConversation(thread)).toMatchObject({
        bindingId: binding.bindingId,
        targetSessionKey: sessionKey,
      });
      expect(binding.metadata?.agentId).toBe("molty");
    }
  });

  it("persists expired bindings after a sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    await createBindingManager({ idleTimeoutMs: 1_000, maxAgeMs: 0, enableSweeper: true });

    await bindCurrentThread({
      targetSessionKey: "agent:ops:subagent:first",
      conversationId: "$thread-1",
    });
    await bindCurrentThread({
      targetSessionKey: "agent:ops:subagent:second",
      conversationId: "$thread-2",
    });

    const sendCallCount = sendMessageMatrixMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(61_000);

    await vi.waitFor(
      () =>
        expect(sendMessageMatrixMock.mock.calls.length).toBeGreaterThanOrEqual(sendCallCount + 2),
      { interval: 10, timeout: 1_000 },
    );
    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "room:!room:example",
      expect.stringContaining("Conversation binding expired"),
      { cfg: {}, client: {}, accountId: "ops", threadId: "$thread-1" },
    );

    await vi.waitFor(
      async () => {
        const persisted = await readPersistedBindings();
        expect(service.resolveByConversation(currentThreadConversation("$thread-1"))).toBeNull();
        expect(persisted).toEqual([]);
      },
      { interval: 10, timeout: 1_000 },
    );
  });

  it.each([undefined, "DEVICE123"])(
    "isolates token rotation by known device (%s)",
    async (deviceId) => {
      const initialAuth = { ...auth, accessToken: "token-old", ...(deviceId ? { deviceId } : {}) };
      const rotatedAuth = { ...initialAuth, accessToken: "token-new" };
      const initialManager = await createBindingManager({ auth: initialAuth });
      await bindCurrentThread();
      const initialStoragePaths = await resolveMatrixStoragePaths({
        ...initialAuth,
        env: process.env,
      });
      await writeStorageMeta({
        storagePaths: initialStoragePaths,
        homeserver: initialAuth.homeserver,
        userId: initialAuth.userId,
        accountId,
        deviceId: deviceId ?? null,
      });
      const initialBindingsPath = path.join(initialStoragePaths.rootDir, "thread-bindings.json");
      if (deviceId) {
        await expectPersistedThreadBinding(initialBindingsPath);
      }
      await initialManager.stop();
      await resetThreadBindingAdapters();
      await createBindingManager({ auth: rotatedAuth });
      const restored = service.resolveByConversation(thread);
      const rotatedBindingsPath = path.join(
        (await resolveMatrixStoragePaths({ ...rotatedAuth, env: process.env })).rootDir,
        "thread-bindings.json",
      );
      if (deviceId) {
        expect(restored?.targetSessionKey).toBe(targetSessionKey);
        expect(rotatedBindingsPath).toBe(initialBindingsPath);
      } else {
        expect(restored).toBeNull();
        expect(rotatedBindingsPath).not.toBe(initialBindingsPath);
      }
    },
  );

  it("replaces reused account managers when the bindings stateDir changes", async () => {
    const initialStateDir = stateDir;
    const replacementStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "matrix-thread-bindings-replacement-"),
    );

    const initialManager = await createBindingManager({ stateDir: initialStateDir });
    await bindCurrentThread();
    const replacementManager = await createBindingManager({ stateDir: replacementStateDir });

    expect(replacementManager).not.toBe(initialManager);
    expect(replacementManager.listBindings()).toStrictEqual([]);
    expect(service.resolveByConversation(thread)).toBeNull();

    await bindCurrentThread({
      targetSessionKey: "agent:ops:subagent:replacement",
      conversationId: "$thread-2",
    });

    await expectPersistedThreadBinding(
      await resolveBindingsFilePath(replacementStateDir),
      "$thread-2",
      "agent:ops:subagent:replacement",
    );
    await expectPersistedThreadBinding(await resolveBindingsFilePath(initialStateDir));

    await initialManager.stop();

    expect(
      replacementManager.getByConversation({
        conversationId: "$thread-2",
        parentConversationId: "!room:example",
      })?.targetSessionKey,
    ).toBe("agent:ops:subagent:replacement");
  });

  it("updates lifecycle windows by session key and refreshes activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const manager = await createBindingManager();
    const original = await bindCurrentThread();
    const idleUpdated = setMatrixThreadBindingIdleTimeoutBySessionKey({
      accountId,
      targetSessionKey,
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    const maxAgeUpdated = setMatrixThreadBindingMaxAgeBySessionKey({
      accountId,
      targetSessionKey,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(idleUpdated).toMatchObject([{ metadata: { idleTimeoutMs: 2 * 60 * 60 * 1000 } }]);
    const expectedActivity = { maxAgeMs: 6 * 60 * 60 * 1000, lastActivityAt: Date.now() };
    expect(maxAgeUpdated).toMatchObject([
      { boundAt: original.boundAt, metadata: expectedActivity },
    ]);
    expect(manager.listBySessionKey(targetSessionKey)[0]).toMatchObject(expectedActivity);
  });

  it("publishes a binding only after its worker write commits", async () => {
    await createBindingManager();
    const gate = pauseNextWrite(false);
    const binding = bindCurrentThread();
    try {
      await gate.entered;
      await expectAvailable(null);
    } finally {
      gate.release();
      await binding;
      gate.restore();
    }
    await expectAvailable({ targetSessionKey });
  });

  it("settles due async activity before returning and coalesces only committed timestamps", async () => {
    const manager = await createBindingManager();
    const binding = await bindCurrentThread();
    const bindingsPath = await resolveBindingsFilePath();
    const touchedAt = binding.boundAt + 60_000;

    const touching = service.touchAsync(binding.bindingId, touchedAt, binding.conversation);
    const snapshot = manager.persist();
    await Promise.all([touching, snapshot]);
    expect(await readPersistedLastActivityAt(bindingsPath)).toBe(touchedAt);

    await service.touchAsync(binding.bindingId, touchedAt + 1_000, binding.conversation);
    expect(await readPersistedLastActivityAt(bindingsPath)).toBe(touchedAt);
    expect(manager.getByConversation(binding.conversation)?.lastActivityAt).toBe(touchedAt + 1_000);
  });

  it("keeps active bindings routable during coalesced touches and flushes the final activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    const manager = await createBindingManager({ idleTimeoutMs: 10_000, enableSweeper: true });
    await vi.advanceTimersByTimeAsync(45_000);
    const binding = await bindCurrentThread();
    const bindingsPath = await resolveBindingsFilePath();

    for (let elapsed = 5_000; elapsed <= 15_000; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      await service.touchAsync(binding.bindingId, Date.now(), binding.conversation);
      const expected = {
        bindingId: binding.bindingId,
        expiresAt: Date.now() + 10_000,
        metadata: { lastActivityAt: Date.now() },
      };
      expect(await service.resolveByConversationAsync(binding.conversation)).toMatchObject(
        expected,
      );
      await expectAvailable(expected, binding.conversation);
    }
    expect(manager.getByConversation(binding.conversation)?.lastActivityAt).toBe(
      binding.boundAt + 15_000,
    );
    expect(await readPersistedLastActivityAt(bindingsPath)).toBe(binding.boundAt);

    await vi.advanceTimersByTimeAsync(30_000);
    await manager.stop();
    expect(await readPersistedLastActivityAt(bindingsPath)).toBe(binding.boundAt + 15_000);
  });

  it.each(["bind", "unbind"] as const)(
    "captures an explicit persistence snapshot after a queued %s settles",
    async (operation) => {
      const manager = await createBindingManager();
      const original = operation === "unbind" ? await bindCurrentThread() : undefined;
      const gate = pauseNextWrite();
      const mutation = original
        ? service.unbind({ bindingId: original.bindingId, reason: "manual" })
        : bindCurrentThread();
      try {
        await gate.entered;
        const persisting = manager.persist();
        gate.release();
        await Promise.all([mutation, persisting]);
      } finally {
        gate.release();
        await mutation;
        gate.restore();
      }
      const persisted = await readPersistedBindings();
      expect(persisted).toMatchObject(
        operation === "bind" ? [{ conversationId: "$thread", targetSessionKey }] : [],
      );
      await expectAvailable(operation === "bind" ? { targetSessionKey } : null);
    },
  );

  it.each(["before-commit", "after-commit"] as const)(
    "reconciles a %s snapshot failure without leaking an unhandled rejection",
    async (failurePoint) => {
      const manager = await createBindingManager();
      await bindCurrentThread({ conversationId: "$first" });
      await bindCurrentThread({ conversationId: "$second" });
      let writes = 0;
      const open = interceptStore((store) => ({
        ...store,
        register: async (...args) => {
          writes += 1;
          if (writes === 2 && failurePoint === "before-commit") {
            throw new Error("snapshot write failed");
          }
          await store.register(...args);
          if (writes === 2) {
            throw new Error("snapshot write failed");
          }
        },
      }));
      const onUnhandledRejection = vi.fn();
      process.on("unhandledRejection", onUnhandledRejection);
      let persisted: Awaited<ReturnType<typeof readPersistedBindings>>;
      try {
        await expect(
          manager.setIdleTimeoutBySessionKeyAsync({
            targetSessionKey,
            idleTimeoutMs: 5_000,
          }),
        ).rejects.toThrow("snapshot write failed");
        // The worker read crosses the event-loop boundary where orphaned rejections surface.
        persisted = await readPersistedBindings();
        expect(onUnhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        open.mockRestore();
      }
      expect(persisted.filter((binding) => binding.idleTimeoutMs === 5_000)).toHaveLength(
        failurePoint === "before-commit" ? 1 : 2,
      );
      for (const record of persisted) {
        const conversation = currentThreadConversation(record.conversationId);
        await expectAvailable({ metadata: { idleTimeoutMs: record.idleTimeoutMs } }, conversation);
        expect(manager.getByConversation({ conversationId: record.conversationId! })).toMatchObject(
          { idleTimeoutMs: record.idleTimeoutMs },
        );
      }
      await manager.persist();
    },
  );

  it.each(["unknown-write", "failed-reconciliation"] as const)(
    "retires uncertain binding projections and settles queued work after %s",
    async (failure) => {
      const manager = await createBindingManager();
      await bindCurrentThread();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      const open = interceptStore((store) => ({
        ...store,
        entries: async () => {
          reads += 1;
          if (reads > 1) {
            throw new Error("durable reconciliation unavailable");
          }
          return await store.entries();
        },
        register: async () => {
          entered.resolve();
          await release.promise;
          if (failure === "unknown-write") {
            throw new Error("write failed", {
              cause: new SqliteWorkerError("worker outcome uncertain", "outcome-unknown"),
            });
          }
          throw new Error("snapshot write failed");
        },
      }));
      const mutation = manager.setIdleTimeoutBySessionKeyAsync({
        targetSessionKey,
        idleTimeoutMs: 5_000,
      });
      const failedMutation = expect(mutation).rejects.toThrow(/restart the account/);
      try {
        await entered.promise;
        const failedQueued = expect(manager.persist()).rejects.toThrow(/retired/);
        const failedStop = expect(manager.stop()).rejects.toThrow(/retired/);
        release.resolve();
        await Promise.all([failedMutation, failedQueued, failedStop]);
        trackedManagers.delete(manager);
        expect(reads).toBe(failure === "unknown-write" ? 1 : 2);
        expect(service.getCapabilities(thread)).toMatchObject({ adapterAvailable: false });
        expect(await service.inspectByConversationAsync(thread)).toMatchObject({ binding: null });
        expect(manager.listBindings()).toEqual([]);
      } finally {
        release.resolve();
        open.mockRestore();
      }
    },
  );

  it.each(["completed", "queued"] as const)(
    "flushes a %s async touch on stop without leaving a delayed write",
    async (touchState) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
      const logVerboseMessage = vi.fn();
      const manager = await createBindingManager({ logVerboseMessage });
      const binding = await bindCurrentThread();
      const touchedAt = binding.boundAt + 5_000;
      const touching = manager.touchBindingAsync(binding.bindingId, touchedAt);
      if (touchState === "completed") {
        await touching;
      }

      await Promise.all([touching, manager.stop()]);
      const bindingsPath = await resolveBindingsFilePath();
      expect(await readPersistedLastActivityAt(bindingsPath)).toBe(touchedAt);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(logVerboseMessage).not.toHaveBeenCalled();
    },
  );
});
