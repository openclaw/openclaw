import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ClickClackDiscussionBinding } from "./binding-store.js";

type RevokedDiscussionChannel = {
  accountId: string;
  serverBaseUrl: string;
  channelId: string;
  revokedAt: number;
};

const REVOKED_CHANNELS_NAMESPACE = "discussion-revoked-channels";
const MAX_REVOKED_CHANNELS = 100_000;
const STORE_OPTIONS = {
  namespace: REVOKED_CHANNELS_NAMESPACE,
  maxEntries: MAX_REVOKED_CHANNELS,
  // Retain evidence for channels that could not be archived; never evict authority.
  overflowPolicy: "reject-new",
} as const;
const storesByRuntime = new WeakMap<
  PluginRuntime,
  PluginStateKeyedStore<RevokedDiscussionChannel, 2>
>();
const nativeStoresByRuntime = new WeakMap<
  PluginRuntime,
  PluginStateSyncKeyedStore<RevokedDiscussionChannel>
>();

function revokedChannelKey(params: { serverBaseUrl: string; channelId: string }): string {
  return [params.serverBaseUrl.replace(/\/+$/u, ""), params.channelId].join("\0");
}

function getStore(runtime: PluginRuntime): PluginStateKeyedStore<RevokedDiscussionChannel, 2> {
  const existing = storesByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = runtime.state.openKeyedStoreV2<RevokedDiscussionChannel>(STORE_OPTIONS);
  storesByRuntime.set(runtime, created);
  return created;
}

/** Records managed ownership before its live binding is released. */
export async function markClickClackDiscussionChannelRevoked(
  runtime: PluginRuntime,
  binding: ClickClackDiscussionBinding,
  options?: { assertCurrent?: () => void },
): Promise<void> {
  const value: RevokedDiscussionChannel = {
    accountId: binding.accountId,
    serverBaseUrl: binding.serverBaseUrl,
    channelId: binding.channelId,
    revokedAt: Date.now(),
  };
  await getStore(runtime).register(revokedChannelKey(value), value, options);
}

export async function markClickClackDiscussionChannelIdentityRevoked(params: {
  runtime: PluginRuntime;
  accountId: string;
  serverBaseUrl: string;
  channelId: string;
}): Promise<void> {
  const value: RevokedDiscussionChannel = {
    accountId: params.accountId,
    serverBaseUrl: params.serverBaseUrl.replace(/\/+$/u, ""),
    channelId: params.channelId,
    revokedAt: Date.now(),
  };
  await getStore(params.runtime).register(revokedChannelKey(value), value);
}

export async function clearClickClackDiscussionChannelRevoked(params: {
  runtime: PluginRuntime;
  serverBaseUrl: string;
  channelId: string;
}): Promise<void> {
  await getStore(params.runtime).delete(revokedChannelKey(params));
}

/** Distinguishes a released managed channel from a genuinely ordinary channel. */
export function isClickClackDiscussionChannelRevoked(params: {
  runtime: PluginRuntime;
  serverBaseUrl: string;
  channelId: string;
}): boolean {
  // Final tool/disclosure authority must observe released synchronous SDK writes.
  let store = nativeStoresByRuntime.get(params.runtime);
  if (!store) {
    store = params.runtime.state.openSyncKeyedStore<RevokedDiscussionChannel>(STORE_OPTIONS);
    nativeStoresByRuntime.set(params.runtime, store);
  }
  return Boolean(store.lookup(revokedChannelKey(params)));
}

export async function isClickClackDiscussionChannelRevokedAsync(params: {
  runtime: PluginRuntime;
  serverBaseUrl: string;
  channelId: string;
}): Promise<boolean> {
  return Boolean(await getStore(params.runtime).lookup(revokedChannelKey(params)));
}
