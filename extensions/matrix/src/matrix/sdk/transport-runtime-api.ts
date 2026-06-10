import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
// Matrix API module exposes the plugin public contract.
import {
  createPinnedLookup,
  isBlockedHostnameOrIp,
  isPrivateNetworkAllowedByPolicy,
  NetworkTargetBlockedError,
  normalizeHostname,
  resolvePinnedHostnameWithPolicy,
  type NetworkTargetPolicy,
  type PinnedDispatcherPolicy,
  type PinnedHostname,
  type PinnedHostnameOverride,
} from "openclaw/plugin-sdk/security-runtime";
export { buildTimeoutAbortSignal } from "./timeout-abort-signal.js";

const DISPATCHER_CLOSE_TIMEOUT_MS = 100;

type MatrixPinnedDispatcher =
  | ReturnType<typeof createHttp1Agent>
  | ReturnType<typeof createHttp1EnvHttpProxyAgent>
  | ReturnType<typeof createHttp1ProxyAgent>;

function withPinnedLookup(
  lookup: PinnedHostname["lookup"],
  connect?: Record<string, unknown>,
): Record<string, unknown> {
  return connect ? { ...connect, lookup } : { lookup };
}

function assertAllowedPinnedOverrideAddresses(
  pinned: PinnedHostname,
  override: PinnedHostnameOverride,
  policy?: NetworkTargetPolicy,
): void {
  const normalizedOverrideHost = normalizeHostname(override.hostname);
  if (!normalizedOverrideHost || normalizedOverrideHost !== pinned.hostname) {
    throw new Error(
      `Pinned dispatcher override hostname mismatch: expected ${pinned.hostname}, got ${override.hostname}`,
    );
  }
  if (isPrivateNetworkAllowedByPolicy(policy)) {
    return;
  }
  for (const address of override.addresses) {
    if (isBlockedHostnameOrIp(address, policy)) {
      throw new NetworkTargetBlockedError(
        "Blocked: resolves to private/internal/special-use IP address",
      );
    }
  }
}

function resolvePinnedDispatcherLookup(
  pinned: PinnedHostname,
  override?: PinnedHostnameOverride,
  policy?: NetworkTargetPolicy,
): PinnedHostname["lookup"] {
  if (!override) {
    return pinned.lookup;
  }
  assertAllowedPinnedOverrideAddresses(pinned, override, policy);
  return createPinnedLookup({
    hostname: pinned.hostname,
    addresses: [...override.addresses],
    fallback: pinned.lookup,
  });
}

function createPinnedDispatcher(
  pinned: PinnedHostname,
  policy?: PinnedDispatcherPolicy,
  networkTargetPolicy?: NetworkTargetPolicy,
): MatrixPinnedDispatcher {
  const lookup = resolvePinnedDispatcherLookup(pinned, policy?.pinnedHostname, networkTargetPolicy);
  if (!policy || policy.mode === "direct") {
    return createHttp1Agent({ connect: withPinnedLookup(lookup, policy?.connect) });
  }
  if (policy.mode === "env-proxy") {
    const targetTls = withPinnedLookup(lookup, policy.connect);
    return createHttp1EnvHttpProxyAgent({
      connect: targetTls,
      requestTls: targetTls,
      ...(policy.proxyTls ? { proxyTls: { ...policy.proxyTls } } : {}),
    });
  }
  const requestTls = withPinnedLookup(lookup, policy.proxyTls);
  return createHttp1ProxyAgent({
    uri: policy.proxyUrl.trim(),
    requestTls,
  });
}

type ClosableDispatcher = {
  close?: () => Promise<void> | void;
  destroy?: () => void;
};

function destroyDispatcher(candidate: ClosableDispatcher): void {
  try {
    candidate.destroy?.();
  } catch {
    // Ignore dispatcher cleanup errors.
  }
}

async function waitForDispatcherClose(candidate: ClosableDispatcher): Promise<void> {
  const close = candidate.close;
  if (typeof close !== "function") {
    destroyDispatcher(candidate);
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(close.call(candidate)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timeout = undefined;
          destroyDispatcher(candidate);
          resolve();
        }, DISPATCHER_CLOSE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } catch (err) {
    destroyDispatcher(candidate);
    throw err;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function closeDispatcher(dispatcher?: MatrixPinnedDispatcher | null): Promise<void> {
  if (!dispatcher) {
    return;
  }
  try {
    await waitForDispatcherClose(dispatcher as ClosableDispatcher);
  } catch {
    // Ignore dispatcher cleanup errors.
  }
}

export {
  closeDispatcher,
  createPinnedDispatcher,
  fetchWithRuntimeDispatcherOrMockedGlobal,
  resolvePinnedHostnameWithPolicy,
  type PinnedDispatcherPolicy,
  type NetworkTargetPolicy,
};
