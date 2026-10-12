import { isDeepStrictEqual } from "node:util";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./binding-store.js";

type RevokedDiscussionChannel = {
  accountId: string;
  serverBaseUrl: string;
  channelId: string;
  revokedAt: number;
  /** Cleanup revokes its captured owner; legacy and unbound-channel markers revoke the room. */
  binding?: ClickClackDiscussionBinding;
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
  sessionKey: string,
  binding: ClickClackDiscussionBinding,
  options?: { assertCurrent?: () => void },
): Promise<boolean> {
  const value: RevokedDiscussionChannel = {
    accountId: binding.accountId,
    serverBaseUrl: binding.serverBaseUrl,
    channelId: binding.channelId,
    revokedAt: Date.now(),
    binding,
  };
  const bindings = getClickClackDiscussionBindingStore(runtime);
  for (;;) {
    const owner = await bindings.observeCurrent(sessionKey);
    const isCurrent = isDeepStrictEqual(owner.binding, binding);
    const observed = await getStore(runtime).observe(revokedChannelKey(value));
    // A legacy or quarantine marker revokes the whole channel and must never be narrowed.
    if (observed.value && !observed.value.binding) {
      return isCurrent;
    }
    // Obsolete cleanup may record an unmarked old channel, but cannot replace newer evidence.
    if (!isCurrent && observed.value) {
      return false;
    }
    let authorityRejected = false;
    try {
      const guarded =
        isCurrent && options?.assertCurrent
          ? runtime.state.openKeyedStoreV2<RevokedDiscussionChannel>(STORE_OPTIONS, {
              assertCurrent: () => {
                try {
                  options.assertCurrent?.();
                } catch (error) {
                  authorityRejected = true;
                  throw error;
                }
              },
            })
          : getStore(runtime);
      const result = await guarded.compareAndApply(
        revokedChannelKey(value),
        observed.comparison,
        { operation: "update", action: "set", value },
        { conditions: [owner.condition] },
      );
      if (result.status !== "conflict") {
        return isCurrent;
      }
    } catch (error) {
      if (authorityRejected) {
        const current = await bindings.observeCurrent(sessionKey);
        if (!isDeepStrictEqual(current.binding, binding)) {
          continue;
        }
      }
      throw error;
    }
  }
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
  binding?: ClickClackDiscussionBinding;
}): boolean {
  // Final tool/disclosure authority must observe released synchronous SDK writes.
  let store = nativeStoresByRuntime.get(params.runtime);
  if (!store) {
    store = params.runtime.state.openSyncKeyedStore<RevokedDiscussionChannel>(STORE_OPTIONS);
    nativeStoresByRuntime.set(params.runtime, store);
  }
  return revocationApplies(store.lookup(revokedChannelKey(params)), params.binding);
}

export async function isClickClackDiscussionChannelRevokedAsync(params: {
  runtime: PluginRuntime;
  serverBaseUrl: string;
  channelId: string;
  binding?: ClickClackDiscussionBinding;
}): Promise<boolean> {
  return revocationApplies(
    await getStore(params.runtime).lookup(revokedChannelKey(params)),
    params.binding,
  );
}

function revocationApplies(
  revoked: RevokedDiscussionChannel | undefined,
  binding: ClickClackDiscussionBinding | undefined,
): boolean {
  return Boolean(
    revoked && (!binding || !revoked.binding || isDeepStrictEqual(revoked.binding, binding)),
  );
}
