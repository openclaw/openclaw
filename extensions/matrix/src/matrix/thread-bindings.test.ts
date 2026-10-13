// Matrix tests cover thread bindings plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
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
import type { MatrixAuth, MatrixStoragePaths } from "./client/types.js";
import {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
  type MatrixThreadBindingManager,
} from "./thread-bindings-shared.js";
import { createMatrixThreadBindingManager } from "./thread-bindings.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (_to: string, _message: string, opts?: { threadId?: string }) => ({
    messageId: opts?.threadId ? "$reply" : "$root",
    roomId: "!room:example",
  })),
);
vi.mock("./send.js", () => {
  return {
    sendMessageMatrix: sendMessageMatrixMock,
  };
});

describe("matrix thread bindings", () => {
  let stateDir: string;
  const auth = {
    accountId: "ops",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
  } as const;
  const accountId = "ops";
  const idleTimeoutMs = 24 * 60 * 60 * 1000;
  const matrixClient = {} as never;
  const trackedManagers = new Set<MatrixThreadBindingManager>();

  async function resetThreadBindingAdapters() {
    await Promise.all([...trackedManagers].map((manager) => manager.stop()));
    trackedManagers.clear();
    testing.resetSessionBindingAdaptersForTests();
  }

  function currentThreadConversation(params?: {
    conversationId?: string;
    parentConversationId?: string;
  }) {
    return {
      channel: "matrix" as const,
      accountId,
      conversationId: params?.conversationId ?? "$thread",
      parentConversationId: params?.parentConversationId ?? "!room:example",
    };
  }

  async function createBindingManager(
    params: {
      auth?: MatrixAuth;
      cfg?: OpenClawConfig;
      stateDir?: string;
      idleTimeoutMs?: number;
      maxAgeMs?: number;
      enableSweeper?: boolean;
      logVerboseMessage?: (message: string) => void;
    } = {},
  ) {
    const manager = await createMatrixThreadBindingManager({
      cfg: params.cfg ?? {},
      accountId,
      auth: params.auth ?? auth,
      client: matrixClient,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      idleTimeoutMs: params.idleTimeoutMs ?? idleTimeoutMs,
      maxAgeMs: params.maxAgeMs ?? 0,
      enableSweeper: params.enableSweeper ?? false,
      ...(params.logVerboseMessage ? { logVerboseMessage: params.logVerboseMessage } : {}),
    });
    trackedManagers.add(manager);
    return manager;
  }

  async function bindCurrentThread(params?: {
    targetSessionKey?: string;
    conversationId?: string;
    parentConversationId?: string;
    metadata?: { introText?: string };
  }) {
    return getSessionBindingService().bind({
      targetSessionKey: params?.targetSessionKey ?? "agent:ops:subagent:child",
      targetKind: "subagent",
      conversation: currentThreadConversation({
        conversationId: params?.conversationId,
        parentConversationId: params?.parentConversationId,
      }),
      placement: "current",
      ...(params?.metadata ? { metadata: params.metadata } : {}),
    });
  }

  async function resolveBindingsFilePath(customStateDir?: string) {
    return await resolveMatrixStateFilePath({
      auth,
      env: process.env,
      ...(customStateDir ? { stateDir: customStateDir } : {}),
      filename: "thread-bindings.json",
    });
  }

  async function writeAuthStorageMeta(authForMeta: MatrixAuth, storagePaths: MatrixStoragePaths) {
    await writeStorageMeta({
      storagePaths,
      homeserver: authForMeta.homeserver,
      userId: authForMeta.userId,
      accountId: authForMeta.accountId,
      deviceId: authForMeta.deviceId ?? null,
    });
  }

  async function readPersistedLastActivityAt(bindingsPath: string) {
    const parsed = await readPersistedBindings(bindingsPath);
    return parsed.bindings?.[0]?.lastActivityAt;
  }

  async function readPersistedBindings(bindingsPath: string) {
    const store = createPluginStateKeyedStoreForTests<{
      accountId?: string;
      conversationId?: string;
      parentConversationId?: string;
      targetSessionKey?: string;
      lastActivityAt?: number;
      boundAt?: number;
      idleTimeoutMs?: number;
    }>("matrix", {
      namespace: "thread-bindings",
      maxEntries: 10_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.dirname(bindingsPath) },
    });
    return {
      bindings: (await store.entries())
        .map((entry) => entry.value)
        .filter((entry) => entry.accountId === accountId)
        .toSorted((a, b) => (a.boundAt ?? 0) - (b.boundAt ?? 0)) as Array<{
        conversationId?: string;
        parentConversationId?: string;
        targetSessionKey?: string;
        lastActivityAt?: number;
        idleTimeoutMs?: number;
      }>,
    };
  }

  async function expectPersistedThreadBinding(
    bindingsPath: string,
    expected: {
      conversationId: string;
      targetSessionKey: string;
      parentConversationId?: string;
    },
  ) {
    const persisted = await readPersistedBindings(bindingsPath);
    expect(persisted.bindings).toHaveLength(1);
    expect(persisted.bindings?.[0]?.conversationId).toBe(expected.conversationId);
    expect(persisted.bindings?.[0]?.parentConversationId).toBe(
      expected.parentConversationId ?? "!room:example",
    );
    expect(persisted.bindings?.[0]?.targetSessionKey).toBe(expected.targetSessionKey);
  }

  function latestSendMessageCall() {
    const call = sendMessageMatrixMock.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected sendMessageMatrix call");
    }
    return call;
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
    await resetThreadBindingAdapters();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("loads and updates thread bindings written by the July SQLite store", async () => {
    const bindingsPath = await resolveBindingsFilePath();
    const store = createPluginStateKeyedStoreForTests("matrix", {
      namespace: "thread-bindings",
      maxEntries: 10_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.dirname(bindingsPath) },
    });
    // v2026.7.1: account id plus sha256(account id, parent room, thread), NUL-separated.
    const key = "ops:df4863925b4d3d0c82df25928e615588bf4a6bd9544af82cf52100573eba9b8b";
    const stored = {
      accountId,
      conversationId: "$thread",
      parentConversationId: "!room:example",
      targetKind: "subagent",
      targetSessionKey: "agent:ops:subagent:child",
      agentId: "ops",
      boundBy: "system",
      boundAt: 1_783_944_000_000,
      lastActivityAt: 1_783_944_000_000,
      idleTimeoutMs,
      maxAgeMs: 0,
    };
    await store.register(key, stored);

    const manager = await createBindingManager();
    const binding = getSessionBindingService().resolveByConversation(currentThreadConversation());
    expect(binding?.targetSessionKey).toBe(stored.targetSessionKey);
    expect(binding?.boundAt).toBe(stored.boundAt);
    if (!binding) {
      throw new Error("expected July Matrix thread binding");
    }
    getSessionBindingService().touch(binding.bindingId, stored.lastActivityAt + 1_000);
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
      bindings: [{ conversationId: "$thread", targetSessionKey: "agent:ops:subagent:child" }],
    });
    await fs.mkdir(path.dirname(bindingsPath), { recursive: true });
    await fs.writeFile(bindingsPath, source);

    await expect(createBindingManager()).rejects.toThrow(/2026\.9\.5/);

    expect(await fs.readFile(bindingsPath, "utf8")).toBe(source);
    expect(fsSync.existsSync(path.join(path.dirname(bindingsPath), "state"))).toBe(false);
    expect(
      getSessionBindingService().resolveByConversation(currentThreadConversation()),
    ).toBeNull();
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
  });

  it("creates child Matrix thread bindings from a top-level room context", async () => {
    await createBindingManager();

    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "matrix",
        accountId: "ops",
        conversationId: "!room:example",
      },
      placement: "child",
      metadata: {
        introText: "intro root",
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith("room:!room:example", "intro root", {
      cfg: {},
      client: {},
      accountId: "ops",
    });
    expect(binding.conversation).toEqual({
      channel: "matrix",
      accountId: "ops",
      conversationId: "$root",
      parentConversationId: "!room:example",
    });
  });

  it("posts intro messages inside existing Matrix threads for current placement", async () => {
    const cfg = { agents: { entries: { main: {}, molty: {} } } };
    await createBindingManager({ cfg });

    const binding = await bindCurrentThread({
      targetSessionKey: "agent:molty:subagent:child",
      metadata: {
        introText: "intro thread",
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith("room:!room:example", "intro thread", {
      cfg,
      client: {},
      accountId: "ops",
      threadId: "$thread",
    });
    const resolved = getSessionBindingService().resolveByConversation({
      channel: "matrix",
      accountId: "ops",
      conversationId: "$thread",
      parentConversationId: "!room:example",
    });
    expect(resolved?.bindingId).toBe(binding.bindingId);
    expect(resolved?.targetSessionKey).toBe("agent:molty:subagent:child");
    expect(binding.metadata?.agentId).toBe("molty");
  });

  it("persists expired bindings after a sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    try {
      await createBindingManager({
        idleTimeoutMs: 1_000,
        maxAgeMs: 0,
        enableSweeper: true,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:ops:subagent:first",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread-1",
          parentConversationId: "!room:example",
        },
        placement: "current",
      });
      await getSessionBindingService().bind({
        targetSessionKey: "agent:ops:subagent:second",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread-2",
          parentConversationId: "!room:example",
        },
        placement: "current",
      });

      const sendCallCount = sendMessageMatrixMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(61_000);

      await vi.waitFor(
        () =>
          expect(sendMessageMatrixMock.mock.calls.length).toBeGreaterThanOrEqual(sendCallCount + 2),
        {
          interval: 10,
          timeout: 1_000,
        },
      );

      await vi.waitFor(
        async () => {
          const persisted = await readPersistedBindings(await resolveBindingsFilePath());
          expect(
            getSessionBindingService().resolveByConversation(
              currentThreadConversation({ conversationId: "$thread-1" }),
            ),
          ).toBeNull();
          expect(persisted.bindings).toEqual([]);
        },
        { interval: 10, timeout: 1_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends threaded farewell messages when bindings are unbound", async () => {
    await createBindingManager({
      idleTimeoutMs: 1_000,
      maxAgeMs: 0,
    });

    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      },
      placement: "current",
      metadata: {
        introText: "intro thread",
      },
    });

    sendMessageMatrixMock.mockClear();
    await getSessionBindingService().unbind({
      bindingId: binding.bindingId,
      reason: "idle-expired",
    });

    const [to, message, options] = latestSendMessageCall();
    const sendOptions = options as { cfg?: unknown; accountId?: string; threadId?: string };
    expect(to).toBe("room:!room:example");
    expect(message).toContain("Conversation binding expired");
    expect(sendOptions.cfg).toEqual({});
    expect(sendOptions.accountId).toBe("ops");
    expect(sendOptions.threadId).toBe("$thread");
  });

  it("does not reload persisted bindings after the Matrix access token changes while deviceId is unknown", async () => {
    const initialAuth = {
      ...auth,
      accessToken: "token-old",
    };
    const rotatedAuth = {
      ...auth,
      accessToken: "token-new",
    };

    const initialManager = await createBindingManager({ auth: initialAuth });

    await bindCurrentThread();
    const initialStoragePaths = await resolveMatrixStoragePaths({
      ...initialAuth,
      env: process.env,
    });
    await writeAuthStorageMeta(initialAuth, initialStoragePaths);

    await initialManager.stop();
    await resetThreadBindingAdapters();

    await createBindingManager({ auth: rotatedAuth });

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toBeNull();

    const initialBindingsPath = path.join(initialStoragePaths.rootDir, "thread-bindings.json");
    const rotatedBindingsPath = path.join(
      (
        await resolveMatrixStoragePaths({
          ...rotatedAuth,
          env: process.env,
        })
      ).rootDir,
      "thread-bindings.json",
    );
    expect(rotatedBindingsPath).not.toBe(initialBindingsPath);
  });

  it("reloads persisted bindings after the Matrix access token changes when deviceId is known", async () => {
    const initialAuth = {
      ...auth,
      accessToken: "token-old",
      deviceId: "DEVICE123",
    };
    const rotatedAuth = {
      ...auth,
      accessToken: "token-new",
      deviceId: "DEVICE123",
    };

    const initialManager = await createBindingManager({ auth: initialAuth });

    await bindCurrentThread();
    const initialStoragePaths = await resolveMatrixStoragePaths({
      ...initialAuth,
      env: process.env,
    });
    await writeAuthStorageMeta(initialAuth, initialStoragePaths);
    const initialBindingsPath = path.join(initialStoragePaths.rootDir, "thread-bindings.json");
    await expectPersistedThreadBinding(initialBindingsPath, {
      conversationId: "$thread",
      targetSessionKey: "agent:ops:subagent:child",
    });

    await initialManager.stop();
    await resetThreadBindingAdapters();

    await createBindingManager({ auth: rotatedAuth });

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      })?.targetSessionKey,
    ).toBe("agent:ops:subagent:child");

    const rotatedBindingsPath = path.join(
      (
        await resolveMatrixStoragePaths({
          ...rotatedAuth,
          env: process.env,
        })
      ).rootDir,
      "thread-bindings.json",
    );
    expect(rotatedBindingsPath).toBe(initialBindingsPath);
  });

  it("replaces reused account managers when the bindings stateDir changes", async () => {
    const initialStateDir = stateDir;
    const replacementStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "matrix-thread-bindings-replacement-"),
    );

    const initialManager = await createBindingManager({
      stateDir: initialStateDir,
    });

    await bindCurrentThread();

    const replacementManager = await createBindingManager({
      stateDir: replacementStateDir,
    });

    expect(replacementManager).not.toBe(initialManager);
    expect(replacementManager.listBindings()).toStrictEqual([]);
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toBeNull();

    await bindCurrentThread({
      targetSessionKey: "agent:ops:subagent:replacement",
      conversationId: "$thread-2",
    });

    await expectPersistedThreadBinding(await resolveBindingsFilePath(replacementStateDir), {
      conversationId: "$thread-2",
      targetSessionKey: "agent:ops:subagent:replacement",
    });
    await expectPersistedThreadBinding(await resolveBindingsFilePath(initialStateDir), {
      conversationId: "$thread",
      targetSessionKey: "agent:ops:subagent:child",
    });

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
    try {
      const manager = await createBindingManager({
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
      });

      await bindCurrentThread();
      const original = manager.listBySessionKey("agent:ops:subagent:child")[0];
      if (original === undefined) {
        throw new Error("expected original matrix thread binding");
      }

      const idleUpdated = setMatrixThreadBindingIdleTimeoutBySessionKey({
        accountId: "ops",
        targetSessionKey: "agent:ops:subagent:child",
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      });
      vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
      const maxAgeUpdated = setMatrixThreadBindingMaxAgeBySessionKey({
        accountId: "ops",
        targetSessionKey: "agent:ops:subagent:child",
        maxAgeMs: 6 * 60 * 60 * 1000,
      });

      expect(idleUpdated).toHaveLength(1);
      expect(idleUpdated[0]?.metadata?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
      expect(maxAgeUpdated).toHaveLength(1);
      expect(maxAgeUpdated[0]?.metadata?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
      expect(maxAgeUpdated[0]?.boundAt).toBe(original.boundAt);
      expect(maxAgeUpdated[0]?.metadata?.lastActivityAt).toBe(
        Date.parse("2026-03-06T12:00:00.000Z"),
      );
      expect(manager.listBySessionKey("agent:ops:subagent:child")[0]?.maxAgeMs).toBe(
        6 * 60 * 60 * 1000,
      );
      expect(manager.listBySessionKey("agent:ops:subagent:child")[0]?.lastActivityAt).toBe(
        Date.parse("2026-03-06T12:00:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a binding only after its worker write commits", async () => {
    await createBindingManager();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const state = getMatrixRuntime().state;
    const openStore = state.openKeyedStoreV2;
    const open = vi.spyOn(state, "openKeyedStoreV2").mockImplementation((options, authority) => {
      const store = openStore(options, authority);
      return {
        ...store,
        register: async (...args) => {
          entered.resolve();
          await release.promise;
          await store.register(...args);
        },
      };
    });
    const binding = bindCurrentThread();
    try {
      await entered.promise;
      expect(
        await getSessionBindingService().inspectByConversationAsync(currentThreadConversation()),
      ).toMatchObject({ status: "available", binding: null });
    } finally {
      release.resolve();
      await binding;
      open.mockRestore();
    }
    expect(
      await getSessionBindingService().inspectByConversationAsync(currentThreadConversation()),
    ).toMatchObject({
      status: "available",
      binding: { targetSessionKey: "agent:ops:subagent:child" },
    });
  });

  it("settles due async activity before returning and coalesces only committed timestamps", async () => {
    const manager = await createBindingManager();
    const binding = await bindCurrentThread();
    const bindingsPath = await resolveBindingsFilePath();
    const touchedAt = binding.boundAt + 60_000;
    const service = getSessionBindingService();

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
    const service = getSessionBindingService();

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
      expect(await service.inspectByConversationAsync(binding.conversation)).toMatchObject({
        status: "available",
        binding: expected,
      });
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
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const state = getMatrixRuntime().state;
      const openStore = state.openKeyedStoreV2;
      let held = false;
      const hold = async () => {
        if (!held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      };
      const open = vi.spyOn(state, "openKeyedStoreV2").mockImplementation((options, authority) => {
        const store = openStore(options, authority);
        return options.namespace === "thread-bindings"
          ? {
              ...store,
              register: async (...args) => {
                await hold();
                return await store.register(...args);
              },
              delete: async (...args) => {
                await hold();
                return await store.delete(...args);
              },
            }
          : store;
      });
      const mutation = original
        ? getSessionBindingService().unbind({ bindingId: original.bindingId, reason: "manual" })
        : bindCurrentThread();
      try {
        await entered.promise;
        const persisting = manager.persist();
        release.resolve();
        await Promise.all([mutation, persisting]);
      } finally {
        release.resolve();
        await mutation;
        open.mockRestore();
      }
      const persisted = await readPersistedBindings(await resolveBindingsFilePath());
      const inspected = await getSessionBindingService().inspectByConversationAsync(
        currentThreadConversation(),
      );
      if (operation === "bind") {
        expect(persisted.bindings).toMatchObject([
          { conversationId: "$thread", targetSessionKey: "agent:ops:subagent:child" },
        ]);
        expect(inspected).toMatchObject({
          status: "available",
          binding: { targetSessionKey: "agent:ops:subagent:child" },
        });
      } else {
        expect(persisted.bindings).toEqual([]);
        expect(inspected).toMatchObject({ status: "available", binding: null });
      }
    },
  );

  it.each(["before-commit", "after-commit"] as const)(
    "reconciles a %s snapshot failure without leaking an unhandled rejection",
    async (failurePoint) => {
      const manager = await createBindingManager();
      await bindCurrentThread({ conversationId: "$first" });
      await bindCurrentThread({ conversationId: "$second" });
      const state = getMatrixRuntime().state;
      const openStore = state.openKeyedStoreV2;
      let writes = 0;
      const open = vi.spyOn(state, "openKeyedStoreV2").mockImplementation((options, authority) => {
        const store = openStore(options, authority);
        return options.namespace === "thread-bindings"
          ? {
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
            }
          : store;
      });
      const onUnhandledRejection = vi.fn();
      process.on("unhandledRejection", onUnhandledRejection);
      let persisted: Awaited<ReturnType<typeof readPersistedBindings>>;
      try {
        await expect(
          manager.setIdleTimeoutBySessionKeyAsync({
            targetSessionKey: "agent:ops:subagent:child",
            idleTimeoutMs: 5_000,
          }),
        ).rejects.toThrow("snapshot write failed");
        // The worker read crosses the event-loop boundary where orphaned rejections surface.
        persisted = await readPersistedBindings(await resolveBindingsFilePath());
        expect(onUnhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        open.mockRestore();
      }
      expect(persisted.bindings.filter((binding) => binding.idleTimeoutMs === 5_000)).toHaveLength(
        failurePoint === "before-commit" ? 1 : 2,
      );
      for (const record of persisted.bindings) {
        expect(
          await getSessionBindingService().inspectByConversationAsync(
            currentThreadConversation({ conversationId: record.conversationId }),
          ),
        ).toMatchObject({
          status: "available",
          binding: { metadata: { idleTimeoutMs: record.idleTimeoutMs } },
        });
        expect(manager.getByConversation({ conversationId: record.conversationId! })).toMatchObject(
          {
            idleTimeoutMs: record.idleTimeoutMs,
          },
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
      const state = getMatrixRuntime().state;
      const openStore = state.openKeyedStoreV2;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      const open = vi.spyOn(state, "openKeyedStoreV2").mockImplementation((options, authority) => {
        const store = openStore(options, authority);
        return options.namespace === "thread-bindings"
          ? {
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
            }
          : store;
      });
      const mutation = manager.setIdleTimeoutBySessionKeyAsync({
        targetSessionKey: "agent:ops:subagent:child",
        idleTimeoutMs: 5_000,
      });
      const failedMutation = expect(mutation).rejects.toThrow(/restart the account/);
      try {
        await entered.promise;
        const queued = manager.persist();
        const failedQueued = expect(queued).rejects.toThrow(/retired/);
        const stopped = manager.stop();
        const failedStop = expect(stopped).rejects.toThrow(/retired/);
        release.resolve();
        await Promise.all([failedMutation, failedQueued, failedStop]);
        trackedManagers.delete(manager);
        expect(reads).toBe(failure === "unknown-write" ? 1 : 2);
        expect(
          getSessionBindingService().getCapabilities(currentThreadConversation()),
        ).toMatchObject({
          adapterAvailable: false,
        });
        expect(
          await getSessionBindingService().inspectByConversationAsync(currentThreadConversation()),
        ).toMatchObject({ binding: null });
        expect(manager.listBindings()).toEqual([]);
      } finally {
        release.resolve();
        open.mockRestore();
      }
    },
  );

  it("persists the latest touched activity only after the debounce window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    try {
      const manager = await createBindingManager();
      const binding = await bindCurrentThread();

      const bindingsPath = await resolveBindingsFilePath();
      const originalLastActivityAt = await readPersistedLastActivityAt(bindingsPath);
      const firstTouchedAt = Date.parse("2026-03-06T10:05:00.000Z");
      const secondTouchedAt = Date.parse("2026-03-06T10:10:00.000Z");

      getSessionBindingService().touch(binding.bindingId, firstTouchedAt);
      getSessionBindingService().touch(binding.bindingId, secondTouchedAt);

      await vi.advanceTimersByTimeAsync(29_000);
      expect(await readPersistedLastActivityAt(bindingsPath)).toBe(originalLastActivityAt);

      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await manager.stop();
      expect(await readPersistedLastActivityAt(bindingsPath)).toBe(secondTouchedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["completed", "queued"] as const)(
    "flushes a %s async touch on stop without leaving a delayed write",
    async (touchState) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
      try {
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
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
