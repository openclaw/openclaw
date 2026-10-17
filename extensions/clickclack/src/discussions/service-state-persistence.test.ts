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
  openOpenClawStateDatabase,
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
import {
  enforceClickClackDiscussionToolTarget,
  isClickClackDiscussionSessionTarget,
} from "./tool-policy.js";

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
    const stateDir = tempDirs.make("openclaw-clickclack-state-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const harness = generationFixture({ env });
      harness.setSessionEntry({ label: "Persisted legacy title" });
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

const services: ClickClackDiscussionService[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.cleanup()));
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
function boundedStoreOptions(namespace = "discussion-bindings") {
  return { namespace, maxEntries: 10_000, overflowPolicy: "reject-new" } as const;
}
const bindingOptions = boundedStoreOptions();
function nativeBindings(env: NodeJS.ProcessEnv) {
  return createPluginStateSyncKeyedStoreForTests<ClickClackDiscussionBinding>("clickclack", {
    ...bindingOptions,
    env,
  });
}
function routeParams(runtime: PluginRuntime, binding: ClickClackDiscussionBinding) {
  const { accountId, serverBaseUrl, workspaceId, channelId } = binding;
  return { runtime, accountId, serverBaseUrl, workspaceId, channelId };
}
function requireBinding(binding: ClickClackDiscussionBinding | undefined) {
  if (!binding) {
    throw new Error("Expected the persisted discussion binding");
  }
  return binding;
}

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
    if (!options.beforeCompare && !options.beforeWrite) {
      return store;
    }
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
  services.push(harness.service);
  return { ...harness, nativeNamespaces, env };
}

it("denies bound messages and session tools after the plugin-state owner publishes revocation", async () => {
  const f = generationFixture();
  const sessionKey = "agent:main:published-revocation";
  await f.service.open(sessionKey);
  const binding = requireBinding(
    await getClickClackDiscussionBindingStore(f.runtime).getAsync(sessionKey),
  );
  const routeInput = routeParams(f.runtime, binding);
  const active = await resolveClickClackDiscussionRoute(routeInput);
  if (active.state !== "active") {
    throw new Error("Expected the original discussion route to be active");
  }
  const send = () =>
    enforceClickClackDiscussionToolTarget({
      runtime: f.runtime,
      context: { toolName: "sessions_send", sessionKey: active.route.sessionKey },
      event: { toolName: "sessions_send", params: { sessionKey, message: "synthetic message" } },
    });
  await expect(send()).resolves.toBeUndefined();

  await markClickClackDiscussionChannelIdentityRevoked(routeInput);

  await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toEqual({
    state: "revoked",
  });
  await expect(send()).resolves.toMatchObject({ block: true });
});

it("denies synchronous session targets while a binding write is pending or has unknown settlement", async () => {
  const f = generationFixture();
  const sessionKey = "agent:main:uncertain-binding-guard";
  await f.service.open(sessionKey);
  const bindings = f.runtime.state.openKeyedStoreV2<ClickClackDiscussionBinding>(bindingOptions);
  const binding = requireBinding(await bindings.lookup(sessionKey));
  const route = await resolveClickClackDiscussionRoute(routeParams(f.runtime, binding));
  if (route.state !== "active") {
    throw new Error("Expected the original discussion route to be active");
  }
  const target = () =>
    isClickClackDiscussionSessionTarget({
      runtime: f.runtime,
      requesterSessionKey: route.route.sessionKey,
      targetSessionKey: sessionKey,
    });
  expect(target()?.sessionKey).toBe(sessionKey);
  const writing = bindings.register(sessionKey, binding);
  try {
    expect(target()).toBeUndefined();
  } finally {
    await writing;
  }
  expect(target()?.sessionKey).toBe(sessionKey);

  const native = f.runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>(bindingOptions);
  const database = openOpenClawStateDatabase({ env: f.env });
  const exec = database.db.exec.bind(database.db);
  let injected = false;
  const failCommitReply = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "COMMIT" && !injected) {
      injected = true;
      throw new Error("synthetic lost commit acknowledgement");
    }
    return result;
  });
  const uncertain = { ...binding, label: "Persisted with unknown settlement" };
  try {
    expect(() => native.register(sessionKey, uncertain)).toThrow();
  } finally {
    failCommitReply.mockRestore();
  }
  expect(injected).toBe(true);
  // A readable durable row cannot restore authority after an unknown commit outcome.
  expect(native.lookup(sessionKey)).toEqual(uncertain);
  expect(target()).toBeUndefined();
});

it("rejects stale discussion indexes after native binding replacement and removal", async () => {
  const f = generationFixture();
  const initialSessionKey = "agent:main:reverse-index-source";
  await f.service.open(initialSessionKey);
  const bindings = getClickClackDiscussionBindingStore(f.runtime);
  const initialBinding = requireBinding(bindings.get(initialSessionKey));
  const native = f.runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>(bindingOptions);
  for (const mutation of ["replace", "delete", "clear"] as const) {
    native.clear();
    const sessionKey = `agent:main:reverse-index-${mutation}`;
    const previous = { ...initialBinding, channelId: `chn_previous_${mutation}` };
    const successor = { ...initialBinding, channelId: `chn_successor_${mutation}` };
    await bindings.setIfCurrent(sessionKey, undefined, previous);
    const routeInput = routeParams(f.runtime, previous);
    const previousRoute = await resolveClickClackDiscussionRoute(routeInput);
    if (previousRoute.state !== "active") {
      throw new Error("Expected the original discussion route to be active");
    }
    const checkToolTarget = (sideSessionKey: string) =>
      enforceClickClackDiscussionToolTarget({
        runtime: f.runtime,
        context: { toolName: "sessions_history", sessionKey: sideSessionKey },
        event: { toolName: "sessions_history", params: { sessionKey } },
      });
    expect(await checkToolTarget(previousRoute.route.sessionKey)).toBeUndefined();

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

    expect((await checkToolTarget(previousRoute.route.sessionKey))?.block).toBe(true);
    await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toEqual({
      state: "unbound",
    });
    const successorRoute = await resolveClickClackDiscussionRoute({
      ...routeInput,
      channelId: successor.channelId,
    });
    if (successorRoute.state !== "active") {
      throw new Error("Stale-index cleanup removed the successor discussion route");
    }
    expect(successorRoute.route.sessionKey).not.toBe(previousRoute.route.sessionKey);
    expect(await checkToolTarget(successorRoute.route.sessionKey)).toBeUndefined();
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
      const native = nativeBindings(f.env);
      const previous = requireBinding(native.lookup(sessionKey));
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
      const routeInput = routeParams(f.runtime, successor);
      if (channel === "different") {
        await expect(
          resolveClickClackDiscussionRoute({ ...routeInput, channelId: previous.channelId }),
        ).resolves.toEqual({ state: "revoked" });
      }
      await expect(
        resolveClickClackDiscussionRoute({ ...routeInput, channelId: successor.channelId }),
      ).resolves.toMatchObject({ state: "active" });
      if (phase === "binding publication") {
        await expect(
          resolveClickClackDiscussionRoute({ ...routeInput, channelId: "chn_candidate" }),
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
    }
  },
);

it("does not narrow an unconditional quarantine when revoking a bound discussion", async () => {
  const f = generationFixture();
  const sessionKey = "agent:main:unconditional-quarantine";
  await f.service.open(sessionKey);
  const native = nativeBindings(f.env);
  const binding = requireBinding(native.lookup(sessionKey));
  const routeInput = routeParams(f.runtime, binding);
  await markClickClackDiscussionChannelIdentityRevoked(routeInput);
  await markClickClackDiscussionChannelRevoked(f.runtime, sessionKey, binding);
  f.config.channels!.clickclack!.discussions!.workspace = "wsp_team";
  const successor = { ...binding, workspaceRef: "wsp_team" };
  native.register(sessionKey, successor);

  await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toEqual({
    state: "revoked",
  });
  expect(native.lookup(sessionKey)).toEqual(successor);
  expect(f.createChannel).toHaveBeenCalledOnce();
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
      const persisted = nativeBindings(f.env);
      expect(persisted.lookup(sessionKey)?.channelId).toBe("chn_discussion");
      await expect(f.service.info(sessionKey)).resolves.toMatchObject({ state: "open" });
    } finally {
      release.resolve();
      await Promise.allSettled([first, second, stopping, restarting]);
      await f.service.cleanup();
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
        ...boundedStoreOptions("discussion-binding-generations"),
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
    await expect(f.service.open("agent:main:failed-worker")).rejects.toBe(failure);
    expect(f.createChannel).not.toHaveBeenCalled();
    expect(f.nativeNamespaces).not.toContain("discussion-binding-generations");
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
        ...boundedStoreOptions("discussion-binding-generations"),
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
