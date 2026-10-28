import { createHash } from "node:crypto";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { getTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramTopicNameCacheForTest,
} from "./runtime.test-support.js";
import {
  getTopicCreatorUserId,
  getTopicName,
  resolveTelegramDirectTopicNameCacheScope,
  recordTopicCreation,
  updateTopicName,
} from "./topic-name-cache.js";

describe("topic-name-cache", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "telegram-topic-names-",
      layout: "state-only",
      applyEnv: true,
    });
    setTelegramPluginStateRuntimeForTests();
    resetTelegramTopicNameCacheForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetTelegramTopicNameCacheForTest();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });

  it("preserves a renamed topic through status-only events without inventing unnamed topics", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments", creatorUserId: 7 });
    await updateTopicName(-100123, 42, { name: "CI/CD" });
    await updateTopicName(-100123, 42, { closed: true });
    await updateTopicName(-100123, 43, { closed: true });
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100123, 42)).resolves.toBe("CI/CD");
    await expect(getTopicCreatorUserId(-100123, 42)).resolves.toBe(7);
    await expect(getTopicName(-100123, 43)).resolves.toBeUndefined();
  });

  it("preserves a queued rename and close when a late creation event arrives", async () => {
    const scope = "queued-creation";
    const namespace = `telegram.topic-name-cache.${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`;
    let entered = false;
    const release = Promise.withResolvers<void>();
    const runtime = getTelegramRuntime();
    const open = runtime.state.openKeyedStore;
    vi.spyOn(runtime.state, "openKeyedStore").mockImplementation(
      <T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = open<T>(options);
        if (options.namespace !== namespace) {
          return store;
        }
        return {
          ...store,
          register: async (...args: Parameters<PluginStateKeyedStore<T>["register"]>) => {
            if (args[0] === "-100123:1") {
              entered = true;
              await release.promise;
            }
            return store.register(...args);
          },
        };
      },
    );
    await getTopicName(-100123, 42, scope);
    const blocker = updateTopicName(-100123, 1, { name: "Blocker" }, scope);
    const pending = [blocker];
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      pending.push(
        updateTopicName(-100123, 42, { name: "Renamed", closed: true }, scope),
        recordTopicCreation(-100123, 42, { name: "Creation event", creatorUserId: 7 }, scope),
      );
      // Let both calls reach the queue while the preceding durable write is held.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      release.resolve();
      await Promise.all(pending);
    }
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    const durable = createPluginStateKeyedStoreForTests<{
      name: string;
      closed?: boolean;
      creatorUserId?: number;
    }>("telegram", { namespace, maxEntries: 2048 });
    await expect(durable.lookup("-100123:42")).resolves.toMatchObject({
      name: "Renamed",
      closed: true,
      creatorUserId: 7,
    });
  });

  it("retains active topics and evicts the inactive oldest topic across database reopen", async () => {
    await updateTopicName(-100000, 1, { name: "Active" });
    for (let id = 2; id <= 2048; id++) {
      await updateTopicName(-100000, id, { name: `Topic ${id}`, creatorUserId: 7 });
    }
    await getTopicName(-100000, 1);
    await updateTopicName(-100000, 9999, { name: "Newcomer" });
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100000, 2)).resolves.toBeUndefined();
    await expect(getTopicCreatorUserId(-100000, 2)).resolves.toBeUndefined();
    await expect(getTopicName(-100000, 1)).resolves.toBe("Active");
    await expect(getTopicName(-100000, 9999)).resolves.toBe("Newcomer");
  });

  it("isolates identical private bot topic coordinates by Telegram account", async () => {
    const sharedStore = "/state/sessions.json";
    const firstAccount = resolveTelegramDirectTopicNameCacheScope(sharedStore, "first-account");
    const secondAccount = resolveTelegramDirectTopicNameCacheScope(sharedStore, "second-account");
    await updateTopicName(42001, 77, { name: "Work" }, firstAccount);
    await updateTopicName(42001, 77, { name: "Personal" }, secondAccount);
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(42001, 77, firstAccount)).resolves.toBe("Work");
    await expect(getTopicName(42001, 77, secondAccount)).resolves.toBe("Personal");
  });

  it("isolates identical topic coordinates in separate persisted scopes", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" }, "first");
    await updateTopicName(-100123, 42, { name: "Incidents" }, "second");
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100123, 42, "first")).resolves.toBe("Deployments");
    await expect(getTopicName(-100123, 42, "second")).resolves.toBe("Incidents");
  });

  it("imports legacy bare-path topic names into a fresh account scope (4304147104)", async () => {
    // Pre-4302875118 install: entries persisted under the bare store-path
    // namespace. After upgrade, account-scoped scopes must not hide them.
    await updateTopicName(
      -100123,
      42,
      { name: "Legacy name", creatorUserId: 7 },
      "legacy-store-path",
    );
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    const accountScope = "legacy-store-path\0telegram-account:default";
    // The upgrade copy runs off the inbound path (4304709769): lookups resolve
    // without awaiting it, and the imported row lands shortly after.
    await expect(getTopicName(-100123, 424242, accountScope)).resolves.toBeUndefined();
    await vi.waitFor(
      async () => {
        await expect(getTopicName(-100123, 42, accountScope)).resolves.toBe("Legacy name");
      },
      { timeout: 10_000 },
    );
    await expect(getTopicName(-100123, 42, accountScope)).resolves.toBe("Legacy name");
    await expect(getTopicCreatorUserId(-100123, 42, accountScope)).resolves.toBe(7);
    // The imported entry now persists under the account scope itself.
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100123, 42, accountScope)).resolves.toBe("Legacy name");
    // A nonempty account scope does not clobber its own entries with legacy ones.
    await updateTopicName(-100123, 42, { name: "Fresh" }, accountScope);
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100123, 42, accountScope)).resolves.toBe("Fresh");
  });

  it("resumes a partial legacy import without clobbering copied rows (4304709767)", async () => {
    await updateTopicName(
      -100123,
      42,
      { name: "Legacy 42", creatorUserId: 7 },
      "legacy-store-path",
    );
    await updateTopicName(
      -100123,
      43,
      { name: "Legacy 43", creatorUserId: 8 },
      "legacy-store-path",
    );
    // Simulate a prior process that crashed after copying only topic 42 (and
    // renaming it): the account-scoped store already persists that row. The
    // old emptiness gate would skip the whole import and lose topic 43.
    await updateTopicName(
      -100123,
      42,
      { name: "Fresh 42" },
      "legacy-store-path\0telegram-account:default",
    );
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    const accountScope = "legacy-store-path\0telegram-account:default";
    await vi.waitFor(
      async () => {
        await expect(getTopicName(-100123, 43, accountScope)).resolves.toBe("Legacy 43");
      },
      { timeout: 10_000 },
    );
    // The already-copied row survives idempotently with its newer values.
    await expect(getTopicName(-100123, 42, accountScope)).resolves.toBe("Fresh 42");
    await expect(getTopicCreatorUserId(-100123, 43, accountScope)).resolves.toBe(8);
  });

  it("backfills legacy ownership after a foreground rename without replacing fresh topic state", async () => {
    const legacyScope = "overlapping-legacy-store";
    const accountScope = `${legacyScope}\0telegram-account:default`;
    const namespace = (scope: string) =>
      `telegram.topic-name-cache.${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`;
    for (const id of [42, 43, 44]) {
      await updateTopicName(-100123, id, { name: `Legacy ${id}`, creatorUserId: 7 }, legacyScope);
    }
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    let entered = false;
    const release = Promise.withResolvers<void>();
    const runtime = getTelegramRuntime();
    const open = runtime.state.openKeyedStore;
    vi.spyOn(runtime.state, "openKeyedStore").mockImplementation(
      <T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = open<T>(options);
        if (options.namespace !== namespace(legacyScope)) {
          return store;
        }
        return {
          ...store,
          entries: async () => {
            const entries = await store.entries();
            entered = true;
            await release.promise;
            return entries;
          },
        };
      },
    );
    const durable = createPluginStateKeyedStoreForTests<{
      name: string;
      closed?: boolean;
      iconColor?: number;
      creatorUserId?: number;
      updatedAt: number;
    }>("telegram", { namespace: namespace(accountScope), maxEntries: 2048 });
    let foreground: Awaited<ReturnType<typeof durable.lookup>>;
    try {
      await getTopicName(-100123, 9999, accountScope);
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      await updateTopicName(
        -100123,
        42,
        { name: "Renamed during upgrade", closed: true, iconColor: 123 },
        accountScope,
      );
      await updateTopicName(
        -100123,
        43,
        { name: "Known account owner", creatorUserId: 99 },
        accountScope,
      );
      foreground = await durable.lookup("-100123:42");
      expect(foreground).toMatchObject({
        name: "Renamed during upgrade",
        closed: true,
        iconColor: 123,
      });
      expect(foreground?.creatorUserId).toBeUndefined();
    } finally {
      release.resolve();
    }
    await vi.waitFor(
      async () => {
        await expect(getTopicCreatorUserId(-100123, 44, accountScope)).resolves.toBe(7);
      },
      { timeout: 10_000 },
    );
    await expect(durable.lookup("-100123:42")).resolves.toEqual({
      ...foreground,
      creatorUserId: 7,
    });
    await expect(getTopicCreatorUserId(-100123, 43, accountScope)).resolves.toBe(99);
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicCreatorUserId(-100123, 42, accountScope)).resolves.toBe(7);
  });

  it("retains fresh account ownership while importing a full legacy cache", async () => {
    const legacyScope = "full-legacy-store";
    for (let id = 1; id <= 2048; id++) {
      await updateTopicName(-100123, id, { name: `Legacy ${id}`, creatorUserId: 7 }, legacyScope);
    }
    const accountScope = `${legacyScope}\0telegram-account:default`;
    await updateTopicName(
      -100123,
      9999,
      { name: "Fresh account title", creatorUserId: 99 },
      accountScope,
    );
    await vi.waitFor(
      async () => {
        await expect(getTopicName(-100123, 2048, accountScope)).resolves.toBe("Legacy 2048");
      },
      { timeout: 20_000 },
    );
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100123, 9999, accountScope)).resolves.toBe("Fresh account title");
    await expect(getTopicCreatorUserId(-100123, 9999, accountScope)).resolves.toBe(99);
    await expect(getTopicName(-100123, 1, accountScope)).resolves.toBeUndefined();
    await expect(getTopicCreatorUserId(-100123, 2048, accountScope)).resolves.toBe(7);
  });

  it("retries an imported row whose durable registration failed", async () => {
    const legacyScope = "retry-legacy-store";
    await updateTopicName(-100123, 42, { name: "Legacy retry", creatorUserId: 7 }, legacyScope);
    const accountScope = `${legacyScope}\0telegram-account:default`;
    const namespace = `telegram.topic-name-cache.${createHash("sha256").update(accountScope).digest("hex").slice(0, 16)}`;
    const runtime = getTelegramRuntime();
    const open = runtime.state.openKeyedStore;
    let failed = false;
    vi.spyOn(runtime.state, "openKeyedStore").mockImplementation(
      <T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = open<T>(options);
        if (options.namespace !== namespace) {
          return store;
        }
        return {
          ...store,
          register: async (...args: Parameters<PluginStateKeyedStore<T>["register"]>) => {
            if (!failed && args[0] === "-100123:42") {
              failed = true;
              throw new Error("Transient import write failure");
            }
            return store.register(...args);
          },
        };
      },
    );
    await getTopicName(-100123, 9999, accountScope);
    await vi.waitFor(() => expect(failed).toBe(true));
    const durable = createPluginStateKeyedStoreForTests<{ name: string; creatorUserId?: number }>(
      "telegram",
      { namespace, maxEntries: 2048 },
    );
    await vi.waitFor(async () => {
      await getTopicName(-100123, 9999, accountScope);
      await expect(durable.lookup("-100123:42")).resolves.toMatchObject({
        name: "Legacy retry",
        creatorUserId: 7,
      });
    });
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicCreatorUserId(-100123, 42, accountScope)).resolves.toBe(7);
  });
});
