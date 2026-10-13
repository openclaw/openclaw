import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateActionAuthority,
  PluginStateCompareIntent,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClickClackClient } from "../http-client.js";
import type { ClickClackChannel } from "../types.js";
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./binding-store.js";
import { getClickClackDiscussionInstallationId } from "./installation.js";
import {
  markClickClackDiscussionChannelIdentityRevoked,
  markClickClackDiscussionChannelRevoked,
} from "./revoked-channel-store.js";
import { resolveClickClackDiscussionRoute } from "./routing.js";
import { discussionChannel, createHarness, testExternalRef } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";
import { enforceClickClackDiscussionToolTarget } from "./tool-policy.js";

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
    const openSyncKeyedStore = (<T>(options: OpenKeyedStoreOptions) => {
      const created = createPluginStateSyncKeyedStoreForTests<T>("clickclack", {
        ...options,
        env,
      });
      return created;
    }) as PluginRuntime["state"]["openSyncKeyedStore"];

    try {
      const harness = createHarness({ label: "Persisted legacy title" }, { openSyncKeyedStore });
      harness.runtime.state.openKeyedStoreV2 = <T>(
        options: OpenAsyncKeyedStoreOptions,
        authority?: PluginStateActionAuthority,
      ) =>
        createPluginStateKeyedStoreForTests<T>("clickclack", { ...options, env }).withCurrent!(
          authority ?? { assertCurrent: () => {} },
        );
      const service = new ClickClackDiscussionService(harness.runtime, {
        clientFactory: () => harness.client,
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

      const binding = await harness.runtime.state
        .openKeyedStoreV2<ClickClackDiscussionBinding>({
          namespace: "discussion-bindings",
          maxEntries: 10_000,
          overflowPolicy: "reject-new",
        })
        .lookup(sessionKey);
      expect(binding).toMatchObject({ channelId: "chn_discussion" });
      expect(binding).not.toHaveProperty("displayTitle");
      const installation = await harness.runtime.state
        .openKeyedStoreV2<{ id: string }>({
          namespace: "discussion-installation",
          maxEntries: 1,
          overflowPolicy: "reject-new",
        })
        .lookup("current");
      expect(installation?.id).toBe(installationId);
      expect(binding?.externalRef).toContain(installationId);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not create a remote channel when installation persistence fails", async () => {
    const harness = createHarness({ label: "Unpersisted installation" });
    const failure = new Error("installation store unavailable");
    harness.runtime.state.openKeyedStoreV2 = () => {
      throw failure;
    };
    const service = new ClickClackDiscussionService(harness.runtime, {
      clientFactory: () => harness.client,
    });

    await expect(service.open("agent:main:unpersisted-installation")).rejects.toBe(failure);
    expect(harness.createChannel).not.toHaveBeenCalled();
  });

  it("requires a durable installation identity after successful registration", async () => {
    const harness = createHarness({ label: "Missing durable installation" });
    const openStore = harness.runtime.state.openKeyedStoreV2;
    harness.runtime.state.openKeyedStoreV2 = <T>(
      options: OpenAsyncKeyedStoreOptions,
      authority?: PluginStateActionAuthority,
    ) => ({
      ...openStore<T>(options, authority),
      registerIfAbsent: async () => true,
      lookup: async () => undefined,
    });
    const service = new ClickClackDiscussionService(harness.runtime, {
      clientFactory: () => harness.client,
    });

    await expect(service.open("agent:main:missing-installation")).rejects.toThrow(
      "installation identity is unavailable",
    );
    expect(harness.createChannel).not.toHaveBeenCalled();
  });

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
    beforeWrite?: (namespace: string, key: string, action: "set" | "delete") => Promise<void>;
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
  harness.runtime.state.openKeyedStoreV2 = <T>(
    storeOptions: OpenAsyncKeyedStoreOptions,
    authority?: PluginStateActionAuthority,
  ) => {
    const store = createPluginStateKeyedStoreForTests<T>("clickclack", { ...storeOptions, env })
      .withCurrent!(authority ?? { assertCurrent: () => {} });
    return {
      ...store,
      compareAndApply: async (...args: Parameters<typeof store.compareAndApply>) => {
        await options.beforeCompare?.(args[0], args[2]);
        if (args[2].action !== "keep") {
          await options.beforeWrite?.(storeOptions.namespace, args[0], args[2].action);
        }
        return await store.compareAndApply(...args);
      },
      register: async (...args: Parameters<typeof store.register>) => {
        await options.beforeWrite?.(storeOptions.namespace, args[0], "set");
        return await store.register(...args);
      },
      delete: async (...args: Parameters<typeof store.delete>) => {
        await options.beforeWrite?.(storeOptions.namespace, args[0], "delete");
        return await store.delete(...args);
      },
    };
  };
  return { ...harness, nativeNamespaces, env };
}

it("rejects stale discussion indexes after native binding replacement and removal", async () => {
  const f = generationFixture();
  const initialSessionKey = "agent:main:reverse-index-source";
  try {
    await f.service.open(initialSessionKey);
    const bindings = getClickClackDiscussionBindingStore(f.runtime);
    const initialBinding = bindings.get(initialSessionKey);
    if (!initialBinding) {
      throw new Error("Expected the persisted discussion binding");
    }
    const native = f.runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>({
      namespace: "discussion-bindings",
      maxEntries: 10_000,
      overflowPolicy: "reject-new",
    });
    for (const mutation of ["replace", "delete", "clear"] as const) {
      native.clear();
      const sessionKey = `agent:main:reverse-index-${mutation}`;
      const previous = { ...initialBinding, channelId: `chn_previous_${mutation}` };
      const successor = { ...initialBinding, channelId: `chn_successor_${mutation}` };
      await bindings.setIfCurrent(sessionKey, undefined, previous);
      const routeParams = {
        runtime: f.runtime,
        accountId: previous.accountId,
        serverBaseUrl: previous.serverBaseUrl,
        workspaceId: previous.workspaceId,
        channelId: previous.channelId,
      };
      const previousRoute = await resolveClickClackDiscussionRoute(routeParams);
      if (previousRoute.state !== "active") {
        throw new Error("Expected the original discussion route to be active");
      }
      const checkToolTarget = (sideSessionKey: string) =>
        enforceClickClackDiscussionToolTarget({
          runtime: f.runtime,
          context: { toolName: "sessions_history", sessionKey: sideSessionKey },
          event: { toolName: "sessions_history", params: { sessionKey } },
        });
      expect(checkToolTarget(previousRoute.route.sessionKey)).toBeUndefined();

      if (mutation === "delete") {
        expect(native.delete(sessionKey)).toBe(true);
      } else if (mutation === "clear") {
        native.clear();
      }
      if (mutation !== "replace") {
        expect(native.lookup(sessionKey)).toBeUndefined();
      }
      native.register(sessionKey, successor);
      // The owning wrapper sees the successor row, so it cannot unindex its predecessor.
      await bindings.setIfCurrent(sessionKey, successor, successor);

      expect(checkToolTarget(previousRoute.route.sessionKey)?.block).toBe(true);
      await expect(resolveClickClackDiscussionRoute(routeParams)).resolves.toEqual({
        state: "unbound",
      });
      const successorRoute = await resolveClickClackDiscussionRoute({
        ...routeParams,
        channelId: successor.channelId,
      });
      if (successorRoute.state !== "active") {
        throw new Error("Stale-index cleanup removed the successor discussion route");
      }
      expect(successorRoute.route.sessionKey).not.toBe(previousRoute.route.sessionKey);
      expect(checkToolTarget(successorRoute.route.sessionKey)).toBeUndefined();
    }
  } finally {
    await f.service.cleanup();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
});

it.each(
  (["revocation", "binding deletion", "binding publication"] as const).flatMap((phase) =>
    (["same", "different"] as const).map((channel) => ({ phase, channel })),
  ),
)(
  "preserves a native successor on the $channel channel when stale discussion $phase waits",
  async ({ phase, channel }) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let armed = false;
    let held = false;
    const f = generationFixture({
      beforeWrite: async (namespace, _key, action) => {
        const targetNamespace =
          phase === "revocation" ? "discussion-revoked-channels" : "discussion-bindings";
        const targetAction = phase === "binding deletion" ? "delete" : "set";
        if (armed && !held && namespace === targetNamespace && action === targetAction) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      },
    });
    const sessionKey = "agent:main:stale-binding-successor";
    let opening: ReturnType<typeof f.service.open> | undefined;
    try {
      await f.service.open(sessionKey);
      const native = createPluginStateSyncKeyedStoreForTests<ClickClackDiscussionBinding>(
        "clickclack",
        {
          namespace: "discussion-bindings",
          maxEntries: 10_000,
          overflowPolicy: "reject-new",
          env: f.env,
        },
      );
      const previous = native.lookup(sessionKey);
      if (!previous) {
        throw new Error("Expected the original discussion binding");
      }
      // The selector changes while resolving to the same workspace, retiring the old binding.
      f.config.channels!.clickclack!.discussions!.workspace = "wsp_team";
      const successor: ClickClackDiscussionBinding = {
        ...previous,
        workspaceRef: "wsp_team",
        ...(channel === "different"
          ? {
              channelId: "chn_successor",
              channelRouteId: "successor-route",
              externalRef: `${previous.externalRef}:successor`,
            }
          : {}),
      };
      f.createChannel.mockImplementationOnce(async (_workspaceId, input) =>
        discussionChannel({ ...input, id: "chn_candidate", route_id: "candidate-route" }),
      );
      armed = true;
      opening = f.service.open(sessionKey);
      await entered.promise;
      native.register(sessionKey, successor);
      release.resolve();
      const opened = await opening;

      expect(native.lookup(sessionKey)).toEqual(successor);
      expect(opened).toEqual({ state: "available" });
      const routeParams = {
        runtime: f.runtime,
        accountId: successor.accountId,
        serverBaseUrl: successor.serverBaseUrl,
        workspaceId: successor.workspaceId,
      };
      if (channel === "different") {
        await expect(
          resolveClickClackDiscussionRoute({ ...routeParams, channelId: previous.channelId }),
        ).resolves.toEqual({ state: "revoked" });
      }
      await expect(
        resolveClickClackDiscussionRoute({ ...routeParams, channelId: successor.channelId }),
      ).resolves.toMatchObject({ state: "active" });
      if (phase === "binding publication") {
        await expect(
          resolveClickClackDiscussionRoute({ ...routeParams, channelId: "chn_candidate" }),
        ).resolves.toEqual({ state: "revoked" });
      }
      const expectedCreates = phase === "binding publication" ? 2 : 1;
      expect(f.createChannel).toHaveBeenCalledTimes(expectedCreates);
      expect(f.updateChannel).not.toHaveBeenCalled();
      await expect(f.service.open(sessionKey)).resolves.toMatchObject({
        state: "open",
        openUrl:
          channel === "same"
            ? "https://clickclack.example/app/team-route/discussion-route"
            : "https://clickclack.example/app/team-route/successor-route",
      });
      expect(native.lookup(sessionKey)).toEqual(successor);
      expect(f.createChannel).toHaveBeenCalledTimes(expectedCreates);
    } finally {
      release.resolve();
      await Promise.allSettled(opening ? [opening] : []);
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  },
);

it("does not narrow an unconditional quarantine when revoking a bound discussion", async () => {
  const f = generationFixture();
  const sessionKey = "agent:main:unconditional-quarantine";
  try {
    await f.service.open(sessionKey);
    const native = createPluginStateSyncKeyedStoreForTests<ClickClackDiscussionBinding>(
      "clickclack",
      {
        namespace: "discussion-bindings",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
        env: f.env,
      },
    );
    const binding = native.lookup(sessionKey);
    if (!binding) {
      throw new Error("Expected the original discussion binding");
    }
    const routeParams = {
      runtime: f.runtime,
      accountId: binding.accountId,
      serverBaseUrl: binding.serverBaseUrl,
      workspaceId: binding.workspaceId,
      channelId: binding.channelId,
    };
    await markClickClackDiscussionChannelIdentityRevoked(routeParams);
    await markClickClackDiscussionChannelRevoked(f.runtime, sessionKey, binding);
    f.config.channels!.clickclack!.discussions!.workspace = "wsp_team";
    const successor = { ...binding, workspaceRef: "wsp_team" };
    native.register(sessionKey, successor);

    await expect(resolveClickClackDiscussionRoute(routeParams)).resolves.toEqual({
      state: "revoked",
    });
    expect(native.lookup(sessionKey)).toEqual(successor);
    expect(f.createChannel).toHaveBeenCalledOnce();
  } finally {
    await f.service.cleanup();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
});

describe("ClickClack pending generation persistence", () => {
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
    const restarting = f.service
      .bindGatewayEvents(undefined, createTestPluginServiceScheduler())
      .then(() => {
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
      expect(f.nativeNamespaces).not.toContain("discussion-binding-generations");
      const persisted = createPluginStateSyncKeyedStoreForTests<{ channelId: string }>(
        "clickclack",
        {
          namespace: "discussion-bindings",
          maxEntries: 10_000,
          overflowPolicy: "reject-new",
          env: f.env,
        },
      );
      expect(persisted.lookup(sessionKey)?.channelId).toBe("chn_discussion");
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
