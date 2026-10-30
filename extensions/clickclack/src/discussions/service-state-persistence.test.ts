import "./service-http-mock.test-support.js";
import "./session-authority.test-support.js";
import assert from "node:assert/strict";
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
  isClickClackDiscussionChannelRevoked,
  isClickClackDiscussionChannelRevokedAsync,
  markClickClackDiscussionChannelIdentityRevoked,
  markClickClackDiscussionChannelRevoked,
} from "./revoked-channel-store.js";
import { resolveClickClackDiscussionRoute } from "./routing.js";
import { discussionChannel, createHarness } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

const sessionKey = "agent:main:persistence";
describe("ClickClack discussion state persistence", () => {
  it("persists legacy title capability through create, sibling backfill and PATCH", async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const f = generationFixture();
    const service = f.service;
    f.createChannel.mockImplementationOnce(async (_workspaceId, input) => {
      const response = discussionChannel(input);
      Reflect.deleteProperty(response, "display_title");
      return response;
    });

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
    await service.reconcile(sessionKey);
    expect(f.updateChannel).not.toHaveBeenCalled();
    f.setSessionEntry({ label: "Sibling" });
    await service.open("agent:main:confirmed-sibling");
    expect(await persistedBinding(f.runtime, "agent:main:confirmed-sibling")).toMatchObject({
      displayTitle: "Sibling",
    });
    f.setSessionEntry({ label: "Title" });
    await service.reconcile(sessionKey);
    expect(f.updateChannel).toHaveBeenCalledWith("chn_discussion", { display_title: "Title" });
    expect(await persistedBinding(f.runtime)).toMatchObject({ displayTitle: "Title" });
    f.setSessionEntry({ label: "New" });
    f.updateChannel.mockImplementationOnce(async (_channelId, patch) => {
      const { display_title: _title, ...fields } = patch;
      return discussionChannel(fields);
    });
    await service.reconcile(sessionKey);
    expect(await persistedBinding(f.runtime)).not.toHaveProperty("displayTitle");
  });

  it.each(["unavailable", "missing"] as const)(
    "does not create a remote channel when installation persistence is %s",
    async (failureMode) => {
      const f = createHarness({ label: "Unpersisted installation" });
      const failure = new Error("installation store unavailable");
      const openStore = f.runtime.state.openKeyedStoreV2;
      f.runtime.state.openKeyedStoreV2 = <T>(
        options: OpenAsyncKeyedStoreOptions,
        authority?: PluginStateActionAuthority,
      ) => {
        if (failureMode === "unavailable") {
          throw failure;
        }
        return {
          ...openStore<T>(options, authority),
          registerIfAbsent: async () => true,
          lookup: async () => undefined,
        };
      };
      const opening = new ClickClackDiscussionService(f.runtime).open(sessionKey);
      if (failureMode === "unavailable") {
        await expect(opening).rejects.toBe(failure);
      } else {
        await expect(opening).rejects.toThrow("installation identity is unavailable");
      }
      expect(f.createChannel).not.toHaveBeenCalled();
    },
  );
});

const services: ClickClackDiscussionService[] = [];
const pausedTasks: Array<{ release: () => void; tasks: Promise<unknown>[] }> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    const paused = pausedTasks.splice(0);
    paused.forEach(({ release }) => release());
    await Promise.allSettled(paused.flatMap(({ tasks }) => tasks));
    await Promise.all(services.splice(0).map((service) => service.cleanup()));
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
// Release blocked operations before service cleanup, even when an assertion fails.
function pause() {
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  const tasks: Promise<unknown>[] = [];
  pausedTasks.push({ release: () => release.resolve(), tasks });
  return {
    entered,
    release,
    track<T>(this: void, task: Promise<T>) {
      tasks.push(task);
      return task;
    },
  };
}
function boundedStoreOptions(namespace = "discussion-bindings") {
  return { namespace, maxEntries: 10_000, overflowPolicy: "reject-new" } as const;
}
const bindingOptions = boundedStoreOptions();
function nativeRevocations(env: NodeJS.ProcessEnv) {
  return createPluginStateSyncKeyedStoreForTests("clickclack", {
    namespace: "discussion-revoked-channels",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
    env,
  });
}
function nativeBindings(env: NodeJS.ProcessEnv) {
  return createPluginStateSyncKeyedStoreForTests<ClickClackDiscussionBinding>("clickclack", {
    ...bindingOptions,
    env,
  });
}
function invoke(
  registration: ReturnType<typeof captureDiscussionRegistration>,
  requester: string,
  toolName: string,
  params: Record<string, unknown>,
) {
  return registration.run({ toolName, params }, { toolName, sessionKey: requester });
}
function expectRoute(
  input: Parameters<typeof resolveClickClackDiscussionRoute>[0],
  state: "revoked" | "unbound",
) {
  return expect(resolveClickClackDiscussionRoute(input)).resolves.toEqual({ state });
}
async function persistedBinding(runtime: PluginRuntime, key = sessionKey) {
  return requireBinding(await getClickClackDiscussionBindingStore(runtime).getAsync(key));
}
async function activeRoute(input: Parameters<typeof resolveClickClackDiscussionRoute>[0]) {
  const result = await resolveClickClackDiscussionRoute(input);
  if (result.state !== "active") {
    throw new Error("Expected an active discussion route");
  }
  return result.route;
}
function requireBinding(binding: ClickClackDiscussionBinding | undefined) {
  assert(binding, "Expected the persisted discussion binding");
  return binding;
}

function generationStore(env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStoreForTests("clickclack", {
    ...boundedStoreOptions("discussion-binding-generations"),
    env,
  });
}
function blockedGeneration(phase: "pending" | "finalize") {
  return blockedWrite((_namespace, intent) =>
    phase === "finalize"
      ? intent.operation === "delete" && intent.action === "delete"
      : intent.operation === "update" &&
        intent.action === "set" &&
        typeof intent.value === "object" &&
        intent.value !== null &&
        "pending" in intent.value,
  );
}
function blockedWrite(
  matches: (namespace: string, intent: PluginStateCompareIntent<unknown>) => boolean,
  initiallyArmed = true,
) {
  const gate = pause();
  let armed = initiallyArmed;
  let held = false;
  const f = generationFixture({
    beforeCompare: async (namespace, intent) => {
      if (armed && !held && matches(namespace, intent)) {
        held = true;
        gate.entered.resolve();
        await gate.release.promise;
      }
    },
  });
  return { ...f, ...gate, arm: () => (armed = true) };
}
function generationFixture(
  options: {
    env?: NodeJS.ProcessEnv;
    beforeCompare?: (namespace: string, intent: PluginStateCompareIntent<unknown>) => Promise<void>;
  } = {},
) {
  const env = options.env ?? {
    ...process.env,
    OPENCLAW_STATE_DIR: tempDirs.make("clickclack-generations-"),
  };
  const f = createHarness(
    { label: "Title" },
    {
      openSyncKeyedStore: <T>(storeOptions: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests<T>("clickclack", { ...storeOptions, env }),
    },
  );
  f.runtime.state.openKeyedStoreV2 = <T>(
    storeOptions: OpenAsyncKeyedStoreOptions,
    authority?: PluginStateActionAuthority,
  ) => {
    const store = createPluginStateKeyedStoreForTests<T>("clickclack", { ...storeOptions, env })
      .withCurrent!(authority ?? { assertCurrent: () => {} });
    if (!options.beforeCompare) {
      return store;
    }
    return {
      ...store,
      compareAndApply: async (...args: Parameters<typeof store.compareAndApply>) => {
        await options.beforeCompare?.(storeOptions.namespace, args[2]);
        return await store.compareAndApply(...args);
      },
    };
  };
  services.push(f.service);
  return { ...f, env };
}

it("denies bound messages and session tools after the plugin-state owner publishes revocation", async () => {
  const f = generationFixture();
  await f.service.open(sessionKey);
  const binding = await persistedBinding(f.runtime);
  const routeInput = { runtime: f.runtime, ...binding };
  const active = await activeRoute(routeInput);
  const registration = captureDiscussionRegistration(f.runtime);
  const send = () =>
    invoke(registration, active.sessionKey, "sessions_send", { sessionKey, message: "x" });
  await expect(send()).resolves.toBeUndefined();

  await markClickClackDiscussionChannelIdentityRevoked(routeInput);

  await expectRoute(routeInput, "revoked");
  await expect(send()).resolves.toMatchObject({ block: true });
  await markClickClackDiscussionChannelRevoked(f.runtime, sessionKey, binding);
  f.config.channels!.clickclack!.discussions!.workspace = "wsp_team";
  const successor = { ...binding, workspaceRef: "wsp_team" };
  const native = nativeBindings(f.env);
  native.register(sessionKey, successor);
  await expectRoute(routeInput, "revoked");
  expect(native.lookup(sessionKey)).toEqual(successor);
  expect(await f.service.readLatestMessages(sessionKey, 30)).toEqual({
    text: "No discussion is bound to this session.",
  });
  expect(f.messagePage).not.toHaveBeenCalled();
  expect(await f.service.info(sessionKey)).toEqual({ state: "available" });
  expect(native.lookup(sessionKey)).toBeUndefined();
});

it("denies synchronous access until legacy SQLite revocations are adopted", async () => {
  const f = generationFixture();
  const channel = { serverBaseUrl: "https://clickclack.example", channelId: "chn_legacy" };
  const legacyKey = `${channel.serverBaseUrl}\0${channel.channelId}`;
  nativeRevocations(f.env).register(legacyKey, {
    accountId: "default",
    ...channel,
    revokedAt: 1,
  });
  const unrevoked = { ...channel, channelId: "chn_unrevoked" };
  captureDiscussionRegistration(f.runtime);
  expect(isClickClackDiscussionChannelRevoked({ runtime: f.runtime, ...channel })).toBe(true);
  expect(isClickClackDiscussionChannelRevoked({ runtime: f.runtime, ...unrevoked })).toBe(true);

  await expect(
    isClickClackDiscussionChannelRevokedAsync({ runtime: f.runtime, ...channel }),
  ).resolves.toBe(true);
  expect(nativeRevocations(f.env).lookup(legacyKey)).toBeUndefined();
  expect(isClickClackDiscussionChannelRevoked({ runtime: f.runtime, ...channel })).toBe(true);
  expect(isClickClackDiscussionChannelRevoked({ runtime: f.runtime, ...unrevoked })).toBe(false);
});

it.each(["unchanged", "revoked", "replaced"] as const)(
  "uses published %s authority when a channel rename resumes without synchronous state reads",
  async (change) => {
    const f = generationFixture();
    const { entered, release, track } = pause();
    await f.service.open(sessionKey);
    const binding = await persistedBinding(f.runtime);
    f.runtime.state.openSyncKeyedStore = () => {
      throw new Error("Synchronous plugin-state reads are unavailable");
    };
    f.setSessionEntry({ label: "New" });
    f.channels.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
    const renaming = track(f.service.reconcile(sessionKey));
    await entered.promise;
    if (change === "revoked") {
      await markClickClackDiscussionChannelIdentityRevoked({ runtime: f.runtime, ...binding });
    } else if (change === "replaced") {
      nativeBindings(f.env).register(sessionKey, { ...binding, channelId: "chn_replacement" });
    }
    release.resolve();
    if (change === "unchanged") {
      await renaming;
      expect(f.updateChannel).toHaveBeenCalledWith(
        binding.channelId,
        expect.objectContaining({ name: "new", display_title: "New" }),
      );
      expect(await persistedBinding(f.runtime)).toMatchObject({ label: "New" });
      await expect(f.service.readLatestMessages(sessionKey, 5)).resolves.toMatchObject({
        text: "The bound discussion has no messages yet.",
      });
    } else {
      await expect(renaming).rejects.toThrow("authority changed before channel update");
      expect(f.updateChannel).not.toHaveBeenCalled();
    }
  },
);

it("denies synchronous session targets while a binding write is pending or has unknown settlement", async () => {
  const f = generationFixture();
  await f.service.open(sessionKey);
  const bindings = f.runtime.state.openKeyedStoreV2<ClickClackDiscussionBinding>(bindingOptions);
  const binding = requireBinding(await bindings.lookup(sessionKey));
  const route = await activeRoute({ runtime: f.runtime, ...binding });
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
  const uncertain = { ...binding, label: "Uncertain" };
  try {
    expect(() => native.register(sessionKey, uncertain)).toThrow();
  } finally {
    failCommitReply.mockRestore();
  }
  // A readable durable row cannot restore authority after an unknown commit outcome.
  expect(native.lookup(sessionKey)).toEqual(uncertain);
  expect(target()).toBeUndefined();
});

it("rejects stale discussion indexes after native binding replacement and removal", async () => {
  const f = generationFixture();
  const initialSessionKey = "agent:main:source";
  await f.service.open(initialSessionKey);
  const bindings = getClickClackDiscussionBindingStore(f.runtime);
  const initialBinding = requireBinding(bindings.get(initialSessionKey));
  const native = f.runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>(bindingOptions);
  const registration = captureDiscussionRegistration(f.runtime);
  for (const mutation of ["replace", "delete", "clear", "external-ref"] as const) {
    native.clear();
    const key = `agent:main:reverse-index-${mutation}`;
    const previous = { ...initialBinding, channelId: `chn_previous_${mutation}` };
    const successor =
      mutation === "external-ref"
        ? { ...previous, externalRef: "openclaw:replacement" }
        : { ...initialBinding, channelId: `chn_successor_${mutation}` };
    await bindings.setIfCurrent(key, undefined, previous);
    const routeInput = { runtime: f.runtime, ...previous };
    const previousRoute = await activeRoute(routeInput);
    const checkToolTarget = (side: string) =>
      invoke(registration, side, "sessions_history", { sessionKey: key });
    expect(await checkToolTarget(previousRoute.sessionKey)).toBeUndefined();

    if (mutation === "delete") {
      expect(native.delete(key)).toBe(true);
    } else if (mutation === "clear") {
      native.clear();
    }
    if (mutation === "delete" || mutation === "clear") {
      expect(native.lookup(key)).toBeUndefined();
      expect((await checkToolTarget(previousRoute.sessionKey))?.block).toBe(true);
      expect(
        (await invoke(registration, previousRoute.sessionKey, "sessions_list", {}))?.block,
      ).toBe(true);
    }
    native.register(key, successor);
    // The owning wrapper sees the successor row, so it cannot unindex its predecessor.
    await bindings.setIfCurrent(key, successor, successor);

    expect((await checkToolTarget(previousRoute.sessionKey))?.block).toBe(true);
    expect(registration.target(previousRoute.sessionKey, key)).toBeUndefined();
    if (mutation !== "external-ref") {
      await expectRoute(routeInput, "unbound");
    }
    const successorRoute = await activeRoute({ ...routeInput, channelId: successor.channelId });
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
    const f = blockedWrite(
      (namespace, intent) =>
        namespace ===
          (phase === "revocation" ? "discussion-revoked-channels" : "discussion-bindings") &&
        intent.action === (phase === "binding deletion" ? "delete" : "set"),
      false,
    );
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
            channelId: "chn_next",
            channelRouteId: "next-route",
            externalRef: `${previous.externalRef}:successor`,
          }
        : {}),
    };
    f.createChannel.mockImplementationOnce(async (_workspaceId, input) =>
      discussionChannel({ ...input, id: "chn_candidate", route_id: "candidate-route" }),
    );
    f.arm();
    const opening = f.track(f.service.open(sessionKey));
    await f.entered.promise;
    native.register(sessionKey, successor);
    f.release.resolve();
    const opened = await opening;

    expect(native.lookup(sessionKey)).toEqual(successor);
    expect(opened).toEqual({ state: "available" });
    const routeInput = { runtime: f.runtime, ...successor };
    if (channel === "different") {
      await expectRoute({ ...routeInput, channelId: previous.channelId }, "revoked");
    }
    await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toMatchObject({
      state: "active",
    });
    if (phase === "binding publication") {
      await expectRoute({ ...routeInput, channelId: "chn_candidate" }, "revoked");
    }
    const expectedCreates = phase === "binding publication" ? 2 : 1;
    expect(f.updateChannel).not.toHaveBeenCalled();
    await expect(f.service.open(sessionKey)).resolves.toMatchObject({
      state: "open",
      openUrl: `https://clickclack.example/app/team-route/${successor.channelRouteId}`,
    });
    expect(native.lookup(sessionKey)).toEqual(successor);
    expect(f.createChannel).toHaveBeenCalledTimes(expectedCreates);
  },
);

describe("ClickClack pending generation persistence", () => {
  it("waits for pending persistence and drains queued opens before restarting", async () => {
    const f = blockedGeneration("pending");
    const { entered, release, track } = f;
    const first = track(f.service.open(sessionKey));
    const second = track(f.service.open(sessionKey));
    await entered.promise;
    const stopping = track(f.service.cleanup());
    let restarted = false;
    const restarting = track(
      f.service.bindGatewayEvents(undefined, createTestPluginServiceScheduler()).then(() => {
        restarted = true;
      }),
    );
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
    const persisted = nativeBindings(f.env);
    expect(persisted.lookup(sessionKey)?.channelId).toBe("chn_discussion");
    await expect(f.service.info(sessionKey)).resolves.toMatchObject({ state: "open" });
  });

  it("retains a replacement generation when an old finalization settles late", async () => {
    const f = blockedGeneration("finalize");
    const { entered, release, track } = f;
    const opening = track(f.service.open(sessionKey));
    await entered.promise;
    const generations = generationStore(f.env);
    const successor = { generation: "successor", destinationIdentity: "other-destination" };
    await generations.register(sessionKey, successor);
    release.resolve();
    await expect(opening).resolves.toMatchObject({ state: "open" });
    expect(await generations.lookup(sessionKey)).toEqual(successor);
  });

  it.each(["token", "apiBaseUrl"] as const)(
    "rechecks %s after a pending write waits",
    async (field) => {
      const f = blockedGeneration("pending");
      const { entered, release, track } = f;
      const opening = track(f.service.open(sessionKey));
      await entered.promise;
      if (field === "token") {
        f.config.channels!.clickclack!.token = "replacement-token";
      } else {
        f.config.channels!.clickclack!.apiBaseUrl = "https://replacement.example";
      }
      release.resolve();
      await expect(opening).rejects.toThrow("authority changed");
      expect(f.createChannel).not.toHaveBeenCalled();
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
    expect(await generationStore(f.env).lookup("agent:main:failed-worker")).toBeUndefined();
  });

  it("quarantines and retries the same pending generation after reopening SQLite", async () => {
    const f = generationFixture();
    vi.mocked(f.createChannel).mockRejectedValueOnce(new Error("lost create response"));
    await expect(f.service.open(sessionKey)).rejects.toThrow("lost create response");
    const originalRef = f.createChannel.mock.calls[0]?.[1].external_ref;
    expect(await generationStore(f.env).lookup(sessionKey)).toMatchObject({
      pending: { externalRef: originalRef },
    });
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
    await recovered.service.reconcileAll();
    await expect(recovered.service.info(sessionKey)).resolves.toMatchObject({ state: "open" });
    expect(recovered.createChannel.mock.calls[0]?.[1].external_ref).toBe(originalRef);
    const generations = generationStore(f.env);
    expect(await generations.lookup(sessionKey)).toBeUndefined();
  });
});
