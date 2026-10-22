import "./service-http-mock.test-support.js";
import "./session-authority.test-support.js";
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
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./binding-store.js";
import { getClickClackDiscussionInstallationId } from "./installation.js";
import { captureDiscussionRegistration } from "./register.test-support.js";
import {
  markClickClackDiscussionChannelIdentityRevoked,
  markClickClackDiscussionChannelRevoked,
} from "./revoked-channel-store.js";
import { resolveClickClackDiscussionRoute } from "./routing.js";
import { discussionChannel, createHarness } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

const sessionKey = "agent:main:persistence";
describe("ClickClack discussion state persistence", () => {
  it("persists legacy create responses through the production plugin-state store", async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const f = generationFixture();
    const service = new ClickClackDiscussionService(f.runtime);
    f.createChannel.mockImplementationOnce(async (_workspaceId, input) => {
      const response = discussionChannel(input);
      Reflect.deleteProperty(response, "display_title");
      return response;
    });

    services.push(service);
    const [opened, installationId] = await Promise.all([
      service.open(sessionKey),
      getClickClackDiscussionInstallationId(f.runtime),
    ]);
    expect(opened).toMatchObject({ state: "open" });

    const binding = await f.runtime.state
      .openKeyedStoreV2<ClickClackDiscussionBinding>(bindingOptions)
      .lookup(sessionKey);
    expect(binding).toMatchObject({ channelId: "chn_discussion" });
    expect(binding).not.toHaveProperty("displayTitle");
    const installation = await f.runtime.state
      .openKeyedStoreV2<{ id: string }>({
        namespace: "discussion-installation",
        maxEntries: 1,
        overflowPolicy: "reject-new",
      })
      .lookup("current");
    expect(installation?.id).toBe(installationId);
    expect(binding?.externalRef).toContain(installationId);
  });

  it("does not create a remote channel when installation persistence fails", async () => {
    const harness = createHarness({ label: "Unpersisted installation" });
    const failure = new Error("installation store unavailable");
    harness.runtime.state.openKeyedStoreV2 = () => {
      throw failure;
    };
    const service = new ClickClackDiscussionService(harness.runtime);

    await expect(service.open("agent:main:unpersisted-installation")).rejects.toBe(failure);
    expect(harness.createChannel).not.toHaveBeenCalled();
  });

  it("requires a durable installation identity after successful registration", async () => {
    const f = createHarness({ label: "Missing durable installation" });
    const openStore = f.runtime.state.openKeyedStoreV2;
    f.runtime.state.openKeyedStoreV2 = <T>(
      options: OpenAsyncKeyedStoreOptions,
      authority?: PluginStateActionAuthority,
    ) => ({
      ...openStore<T>(options, authority),
      registerIfAbsent: async () => true,
      lookup: async () => undefined,
    });
    const service = new ClickClackDiscussionService(f.runtime);

    await expect(service.open("agent:main:missing-installation")).rejects.toThrow(
      "installation identity is unavailable",
    );
    expect(f.createChannel).not.toHaveBeenCalled();
  });

  it("clears stale display title confirmation when a patch response omits the field", async () => {
    const f = createHarness({ label: "Original title" });
    await f.service.open(sessionKey);
    expect(f.store.lookup(sessionKey)).toMatchObject({ displayTitle: "Original title" });

    f.setSessionEntry({ label: "Updated title" });
    f.updateChannel.mockImplementationOnce(async (_channelId, patch) => {
      const { display_title: _title, ...fields } = patch;
      return discussionChannel(fields);
    });

    await f.service.reconcile(sessionKey);

    expect(f.store.lookup(sessionKey)).not.toHaveProperty("displayTitle");
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
async function activeRoute(input: Parameters<typeof resolveClickClackDiscussionRoute>[0]) {
  const result = await resolveClickClackDiscussionRoute(input);
  if (result.state !== "active") {
    throw new Error("Expected an active discussion route");
  }
  return result.route;
}
function requireBinding(binding: ClickClackDiscussionBinding | undefined) {
  if (!binding) {
    throw new Error("Expected the persisted discussion binding");
  }
  return binding;
}

function generationStore(env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStoreForTests("clickclack", {
    ...boundedStoreOptions("discussion-binding-generations"),
    env,
  });
}
function blockedGeneration(phase: "pending" | "finalize", once = false) {
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  let blocked = false;
  const f = generationFixture({
    beforeCompare: async (_key, intent) => {
      const matches =
        phase === "finalize"
          ? intent.operation === "delete" && intent.action === "delete"
          : intent.operation === "update" &&
            intent.action === "set" &&
            typeof intent.value === "object" &&
            intent.value !== null &&
            "pending" in intent.value;
      if (matches && (!once || !blocked)) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
    },
  });
  return { ...f, entered, release };
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
  const f = createHarness(
    { label: "Worker discussion" },
    {
      openSyncKeyedStore: <T>(storeOptions: OpenKeyedStoreOptions) => {
        nativeNamespaces.push(storeOptions.namespace);
        return createPluginStateSyncKeyedStoreForTests<T>("clickclack", { ...storeOptions, env });
      },
    },
  );
  f.runtime.state.openKeyedStoreV2 = <T>(
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
  services.push(f.service);
  return { ...f, nativeNamespaces, env };
}

it("denies bound messages and session tools after the plugin-state owner publishes revocation", async () => {
  const f = generationFixture();
  await f.service.open(sessionKey);
  const binding = requireBinding(
    await getClickClackDiscussionBindingStore(f.runtime).getAsync(sessionKey),
  );
  const routeInput = routeParams(f.runtime, binding);
  const active = await activeRoute(routeInput);
  const registration = captureDiscussionRegistration(f.runtime);
  const send = () =>
    registration.run(
      { toolName: "sessions_send", params: { sessionKey, message: "synthetic message" } },
      { toolName: "sessions_send", sessionKey: active.sessionKey },
    );
  await expect(send()).resolves.toBeUndefined();

  await markClickClackDiscussionChannelIdentityRevoked(routeInput);

  await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toEqual({ state: "revoked" });
  await expect(send()).resolves.toMatchObject({ block: true });
});

it.each(["unchanged", "revoked", "replaced"] as const)(
  "uses published %s authority when a channel rename resumes without synchronous state reads",
  async (change) => {
    const f = generationFixture();
    const renameSessionKey = "agent:main:prepared-rename";
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let renaming: Promise<void> | undefined;
    try {
      await f.service.open(renameSessionKey);
      const binding = await getClickClackDiscussionBindingStore(f.runtime).getAsync(
        renameSessionKey,
      );
      if (!binding) {
        throw new Error("Expected the persisted discussion binding");
      }
      f.runtime.state.openSyncKeyedStore = () => {
        throw new Error("Synchronous plugin-state reads are unavailable");
      };
      f.setSessionEntry({ label: "Updated title" });
      f.channels.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [];
      });
      renaming = f.service.reconcile(renameSessionKey);
      await entered.promise;
      if (change === "revoked") {
        const revocations = createPluginStateSyncKeyedStoreForTests("clickclack", {
          namespace: "discussion-revoked-channels",
          maxEntries: 100_000,
          overflowPolicy: "reject-new",
          env: f.env,
        });
        revocations.register(`${binding.serverBaseUrl}\0${binding.channelId}`, {
          accountId: binding.accountId,
          serverBaseUrl: binding.serverBaseUrl,
          channelId: binding.channelId,
          revokedAt: Date.now(),
        });
      } else if (change === "replaced") {
        const bindings = createPluginStateSyncKeyedStoreForTests("clickclack", {
          namespace: "discussion-bindings",
          maxEntries: 10_000,
          overflowPolicy: "reject-new",
          env: f.env,
        });
        bindings.register(renameSessionKey, { ...binding, channelId: "chn_replacement" });
      }
      release.resolve();
      if (change === "unchanged") {
        await renaming;
        expect(f.updateChannel).toHaveBeenCalledWith(
          binding.channelId,
          expect.objectContaining({ name: "updated-title", display_title: "Updated title" }),
        );
        expect(
          await getClickClackDiscussionBindingStore(f.runtime).getAsync(renameSessionKey),
        ).toMatchObject({ label: "Updated title" });
        await expect(f.service.readLatestMessages(renameSessionKey, 5)).resolves.toMatchObject({
          text: "The bound discussion has no messages yet.",
        });
      } else {
        await expect(renaming).rejects.toThrow("authority changed before channel update");
        expect(f.updateChannel).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      await renaming?.catch(() => undefined);
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  },
);

it("denies synchronous session targets while a binding write is pending or has unknown settlement", async () => {
  const f = generationFixture();
  await f.service.open(sessionKey);
  const bindings = f.runtime.state.openKeyedStoreV2<ClickClackDiscussionBinding>(bindingOptions);
  const binding = requireBinding(await bindings.lookup(sessionKey));
  const route = await activeRoute(routeParams(f.runtime, binding));
  const registration = captureDiscussionRegistration(f.runtime);
  const target = () => registration.target(route.sessionKey, sessionKey);
  expect(target()?.expectedSessionId).toBe(binding.sessionId);
  const writing = bindings.register(sessionKey, binding);
  try {
    expect(target()).toBeUndefined();
  } finally {
    await writing;
  }
  expect(target()?.expectedSessionId).toBe(binding.sessionId);

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
  const registration = captureDiscussionRegistration(f.runtime);
  for (const mutation of ["replace", "delete", "clear"] as const) {
    native.clear();
    const key = `agent:main:reverse-index-${mutation}`;
    const previous = { ...initialBinding, channelId: `chn_previous_${mutation}` };
    const successor = { ...initialBinding, channelId: `chn_successor_${mutation}` };
    await bindings.setIfCurrent(key, undefined, previous);
    const routeInput = routeParams(f.runtime, previous);
    const previousRoute = await activeRoute(routeInput);
    const checkToolTarget = (sideSessionKey: string) =>
      registration.run(
        { toolName: "sessions_history", params: { sessionKey: key } },
        { toolName: "sessions_history", sessionKey: sideSessionKey },
      );
    expect(await checkToolTarget(previousRoute.sessionKey)).toBeUndefined();

    if (mutation === "delete") {
      expect(native.delete(key)).toBe(true);
    } else if (mutation === "clear") {
      native.clear();
    }
    if (mutation !== "replace") {
      expect(native.lookup(key)).toBeUndefined();
    }
    native.register(key, successor);
    // The owning wrapper sees the successor row, so it cannot unindex its predecessor.
    await bindings.setIfCurrent(key, successor, successor);

    expect((await checkToolTarget(previousRoute.sessionKey))?.block).toBe(true);
    await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toEqual({
      state: "unbound",
    });
    const successorRoute = await activeRoute({
      ...routeInput,
      channelId: successor.channelId,
    });
    expect(successorRoute.sessionKey).not.toBe(previousRoute.sessionKey);
    expect(await checkToolTarget(successorRoute.sessionKey)).toBeUndefined();
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
    }
  },
);

it("does not narrow an unconditional quarantine when revoking a bound discussion", async () => {
  const f = generationFixture();
  await f.service.open(sessionKey);
  const native = nativeBindings(f.env);
  const binding = requireBinding(native.lookup(sessionKey));
  const routeInput = routeParams(f.runtime, binding);
  await markClickClackDiscussionChannelIdentityRevoked(routeInput);
  await markClickClackDiscussionChannelRevoked(f.runtime, sessionKey, binding);
  f.config.channels!.clickclack!.discussions!.workspace = "wsp_team";
  const successor = { ...binding, workspaceRef: "wsp_team" };
  native.register(sessionKey, successor);

  await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toEqual({ state: "revoked" });
  expect(native.lookup(sessionKey)).toEqual(successor);
  expect(f.createChannel).toHaveBeenCalledOnce();
});

describe("ClickClack pending generation persistence", () => {
  it("waits for pending persistence and drains queued opens before restarting", async () => {
    const f = blockedGeneration("pending", true);
    const { entered, release } = f;
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
    }
  });

  it("retains a replacement generation when an old finalization settles late", async () => {
    const f = blockedGeneration("finalize");
    const { entered, release } = f;
    const opening = f.service.open(sessionKey);
    await entered.promise;
    try {
      const generations = generationStore(f.env);
      const successor = { generation: "successor", destinationIdentity: "other-destination" };
      await generations.register(sessionKey, successor);
      release.resolve();
      await expect(opening).resolves.toMatchObject({ state: "open" });
      expect(await generations.lookup(sessionKey)).toEqual(successor);
    } finally {
      release.resolve();
      await Promise.allSettled([opening]);
    }
  });

  it.each(["token", "apiBaseUrl"] as const)(
    "rechecks %s after a pending write waits",
    async (field) => {
      const f = blockedGeneration("pending");
      const { entered, release } = f;
      const opening = f.service.open(sessionKey);
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
    await expect(f.service.open(sessionKey)).rejects.toThrow("lost create response");
    await f.service.cleanup();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const recovered = generationFixture({ env: f.env });
    await expect(
      resolveClickClackDiscussionRoute({
        runtime: recovered.runtime,
        accountId: "default",
        serverBaseUrl: "https://clickclack.example",
        workspaceId: "wsp_team",
        channelId: "unknown-created-room",
      }),
    ).resolves.toEqual({ state: "revoked" });
    await expect(recovered.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });
    const generations = generationStore(f.env);
    expect(await generations.lookup(sessionKey)).toBeUndefined();
  });
});
