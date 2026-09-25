import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateCompareIntent,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClickClackClient } from "../http-client.js";
import type { ClickClackChannel } from "../types.js";
import type { ClickClackDiscussionBinding } from "./binding-store.js";
import { getClickClackDiscussionInstallationId } from "./installation.js";
import { resolveClickClackDiscussionRoute } from "./routing.js";
import { discussionChannel, createHarness, testExternalRef } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

function legacyCreateResponse(
  input: Parameters<ClickClackClient["createChannel"]>[1],
): ClickClackChannel {
  const response: ClickClackChannel = discussionChannel({
    ...input,
    kind: "public",
  });
  Reflect.deleteProperty(response, "display_title");
  return response;
}

describe("ClickClack discussion state persistence", () => {
  it("persists legacy create responses through the production plugin-state store", async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-clickclack-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const stores = new Map<string, PluginStateSyncKeyedStore<unknown>>();
    const openSyncKeyedStore = (<T>(options: OpenKeyedStoreOptions) => {
      const created = createPluginStateSyncKeyedStoreForTests<T>("clickclack", {
        ...options,
        env,
      });
      stores.set(options.namespace, created as PluginStateSyncKeyedStore<unknown>);
      return created;
    }) as PluginRuntime["state"]["openSyncKeyedStore"];

    try {
      const harness = createHarness({ label: "Persisted legacy title" }, { openSyncKeyedStore });
      harness.runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("clickclack", { ...options, env });
      const service = new ClickClackDiscussionService(harness.runtime, {
        clientFactory: () => harness.client,
        startTimer: false,
      });
      const sessionKey = "agent:main:persisted-legacy-title";
      vi.mocked(harness.createChannel).mockImplementationOnce(async (_workspaceId, input) =>
        legacyCreateResponse(input),
      );

      const [opened, installationId] = await Promise.all([
        service.open(sessionKey),
        getClickClackDiscussionInstallationId(harness.runtime),
      ]);
      expect(opened).toMatchObject({ state: "open" });

      const binding = stores
        .get("discussion-bindings")
        ?.lookup(sessionKey) as ClickClackDiscussionBinding;
      expect(binding).toMatchObject({ channelId: "chn_discussion" });
      expect(binding).not.toHaveProperty("displayTitle");
      const installation = await harness.runtime.state
        .openKeyedStore<{ id: string }>({
          namespace: "discussion-installation",
          maxEntries: 1,
          overflowPolicy: "reject-new",
        })
        .lookup("current");
      expect(installation?.id).toBe(installationId);
      expect(binding.externalRef).toContain(installationId);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not create a remote channel when installation persistence fails", async () => {
    const harness = createHarness({ label: "Unpersisted installation" });
    const failure = new Error("installation store unavailable");
    harness.runtime.state.openKeyedStore = () => {
      throw failure;
    };
    const service = new ClickClackDiscussionService(harness.runtime, {
      clientFactory: () => harness.client,
      startTimer: false,
    });

    await expect(service.open("agent:main:unpersisted-installation")).rejects.toBe(failure);
    expect(harness.createChannel).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires a durable installation identity after registration returns %s",
    async (registered) => {
      const harness = createHarness({ label: "Missing durable installation" });
      harness.runtime.state.openKeyedStore = () => ({
        register: async () => {},
        registerIfAbsent: async () => registered,
        lookup: async () => undefined,
        consume: async () => undefined,
        delete: async () => false,
        entries: async () => [],
        clear: async () => {},
      });
      const service = new ClickClackDiscussionService(harness.runtime, {
        clientFactory: () => harness.client,
        startTimer: false,
      });

      await expect(service.open("agent:main:missing-installation")).rejects.toThrow(
        "installation identity is unavailable",
      );
      expect(harness.createChannel).not.toHaveBeenCalled();
    },
  );

  it("clears stale display title confirmation when a patch response omits the field", async () => {
    const harness = createHarness({ label: "Original title" });
    const sessionKey = "agent:main:stale-title-confirmation";
    await harness.service.open(sessionKey);
    expect(harness.store.lookup(sessionKey)).toMatchObject({ displayTitle: "Original title" });

    harness.setSessionEntry({ label: "Updated title" });
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (_channelId, patch) =>
      discussionChannel({
        name: patch.name ?? "updated-title",
        external_managed: true,
        external_ref: testExternalRef(sessionKey),
        external_url: "https://control.example/control/chat/main/stale-title-confirmation",
        sidebar_section: "Sessions",
      }),
    );

    await harness.service.reconcile(sessionKey);

    expect(harness.store.lookup(sessionKey)).not.toHaveProperty("displayTitle");
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function generationFixture(
  options: {
    env?: NodeJS.ProcessEnv;
    beforeCompare?: (key: string, intent: PluginStateCompareIntent<unknown>) => Promise<void>;
    host?: "modern" | "no-observe" | "no-compare";
  } = {},
) {
  const env = options.env ?? {
    ...process.env,
    OPENCLAW_STATE_DIR: tempDirs.make("clickclack-generations-"),
  };
  const nativeNamespaces: string[] = [];
  const harness = createHarness(
    { label: "Worker discussion" },
    {
      openSyncKeyedStore: <T>(storeOptions: OpenKeyedStoreOptions) => {
        nativeNamespaces.push(storeOptions.namespace);
        return createPluginStateSyncKeyedStoreForTests<T>("clickclack", { ...storeOptions, env });
      },
    },
  );
  harness.runtime.state.openKeyedStore = <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests<T>("clickclack", { ...storeOptions, env });
    return {
      ...store,
      update: async () => {
        throw new Error("Unexpected native callback update");
      },
      deleteIf: async () => {
        throw new Error("Unexpected native callback deletion");
      },
      observe: options.host === "no-observe" ? undefined : store.observe,
      compareAndApply:
        options.host === "no-compare"
          ? undefined
          : async (...args: Parameters<typeof store.compareAndApply>) => {
              await options.beforeCompare?.(args[0], args[2]);
              return await store.compareAndApply(...args);
            },
    };
  };
  return { ...harness, nativeNamespaces, env };
}

describe("ClickClack pending generation persistence", () => {
  it("joins an accepted open through persistence before cleanup settles", async () => {
    const f = generationFixture();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const workspaces = f.client.workspaces.bind(f.client);
    vi.mocked(f.client.workspaces).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return await workspaces();
    });
    const opening = f.service.open("agent:main:draining");
    await entered.promise;
    let stopped = false;
    const stopping = Promise.resolve(f.service.cleanup()).then(() => {
      stopped = true;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBe(false);
      release.resolve();
      await expect(opening).resolves.toMatchObject({ state: "open" });
      await stopping;
      const persisted = createPluginStateSyncKeyedStoreForTests<{ channelId: string }>(
        "clickclack",
        {
          namespace: "discussion-bindings",
          maxEntries: 10_000,
          overflowPolicy: "reject-new",
          env: f.env,
        },
      );
      expect(persisted.lookup("agent:main:draining")?.channelId).toBe("chn_discussion");
    } finally {
      release.resolve();
      await Promise.allSettled([opening, stopping]);
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  });

  it("opens a discussion without selecting native generation storage", async () => {
    const f = generationFixture();
    try {
      await expect(f.service.open("agent:main:worker")).resolves.toMatchObject({ state: "open" });
      expect(f.nativeNamespaces).not.toContain("discussion-binding-generations");
    } finally {
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  });
  it.each(["no-observe", "no-compare"] as const)(
    "retains the 2026.9.4 host path with %s",
    async (host) => {
      const f = generationFixture({ host });
      try {
        await expect(f.service.open("agent:main:legacy-host")).resolves.toMatchObject({
          state: "open",
        });
        expect(f.nativeNamespaces).toContain("discussion-binding-generations");
      } finally {
        await f.service.cleanup();
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    },
  );

  it("waits for pending persistence and drains queued opens before restarting", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let blocked = false;
    const f = generationFixture({
      beforeCompare: async (_key, intent) => {
        if (
          !blocked &&
          intent.operation === "update" &&
          intent.action === "set" &&
          typeof intent.value === "object" &&
          intent.value !== null &&
          "pending" in intent.value
        ) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
      },
    });
    const sessionKey = "agent:main:worker-drain";
    const first = f.service.open(sessionKey);
    const second = f.service.open(sessionKey);
    await entered.promise;
    const stopping = f.service.cleanup();
    let restarted = false;
    const restarting = f.service.bindGatewayEvents(undefined).then(() => {
      restarted = true;
    });
    try {
      await expect(f.service.open("agent:main:too-late")).rejects.toThrow("service is stopped");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(restarted).toBe(false);
      expect(f.createChannel).not.toHaveBeenCalled();
      release.resolve();
      await expect(first).resolves.toMatchObject({ state: "open" });
      await expect(second).resolves.toMatchObject({ state: "open" });
      await stopping;
      await restarting;
      expect(f.createChannel).toHaveBeenCalledOnce();
      await expect(f.service.info(sessionKey)).resolves.toMatchObject({ state: "open" });
    } finally {
      release.resolve();
      await Promise.allSettled([first, second, stopping, restarting]);
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  });

  it("retains a replacement generation when an old finalization settles late", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const f = generationFixture({
      beforeCompare: async (_key, intent) => {
        if (intent.operation === "delete" && intent.action === "delete") {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const sessionKey = "agent:main:replacement-generation";
    const opening = f.service.open(sessionKey);
    await entered.promise;
    try {
      const generations = createPluginStateKeyedStoreForTests("clickclack", {
        namespace: "discussion-binding-generations",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
        env: f.env,
      });
      const successor = { generation: "successor", destinationIdentity: "other-destination" };
      await generations.register(sessionKey, successor);
      release.resolve();
      await expect(opening).resolves.toMatchObject({ state: "open" });
      expect(await generations.lookup(sessionKey)).toEqual(successor);
    } finally {
      release.resolve();
      await Promise.allSettled([opening]);
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  });

  it.each(["token", "apiBaseUrl"] as const)(
    "rechecks %s after a pending write waits",
    async (field) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const f = generationFixture({
        beforeCompare: async (_key, intent) => {
          if (
            intent.operation === "update" &&
            intent.action === "set" &&
            typeof intent.value === "object" &&
            intent.value !== null &&
            "pending" in intent.value
          ) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      const opening = f.service.open("agent:main:changed-account");
      await entered.promise;
      try {
        if (field === "token") {
          f.config.channels!.clickclack!.token = "replacement-token";
        } else {
          f.config.channels!.clickclack!.apiBaseUrl = "https://replacement.example";
        }
        release.resolve();
        await expect(opening).rejects.toThrow("authority changed");
        expect(f.createChannel).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([opening]);
        await f.service.cleanup();
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    },
  );

  it("does not replay a failed worker mutation through native storage", async () => {
    const failure = new Error("generation worker unavailable");
    const f = generationFixture({
      beforeCompare: async () => {
        throw failure;
      },
    });
    try {
      await expect(f.service.open("agent:main:failed-worker")).rejects.toBe(failure);
      expect(f.createChannel).not.toHaveBeenCalled();
      expect(f.nativeNamespaces).not.toContain("discussion-binding-generations");
    } finally {
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  });

  it("quarantines an ambiguous create after reopening SQLite with a fresh runtime", async () => {
    const f = generationFixture();
    vi.mocked(f.createChannel).mockRejectedValueOnce(new Error("lost create response"));
    let recovered: ReturnType<typeof generationFixture> | undefined;
    try {
      await expect(f.service.open("agent:main:restart-recovery")).rejects.toThrow(
        "lost create response",
      );
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      recovered = generationFixture({ env: f.env });
      await expect(
        resolveClickClackDiscussionRoute({
          runtime: recovered.runtime,
          accountId: "default",
          serverBaseUrl: "https://clickclack.example",
          workspaceId: "wsp_team",
          channelId: "unknown-created-room",
        }),
      ).resolves.toEqual({ state: "revoked" });
      await expect(recovered.service.open("agent:main:restart-recovery")).resolves.toMatchObject({
        state: "open",
      });
      const generations = createPluginStateKeyedStoreForTests("clickclack", {
        namespace: "discussion-binding-generations",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
        env: f.env,
      });
      expect(await generations.lookup("agent:main:restart-recovery")).toBeUndefined();
    } finally {
      await f.service.cleanup();
      await recovered?.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  });
});
