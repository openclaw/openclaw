import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestClient } from "@buape/carbon";
import { wrapFetchWithAbortSignal } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { Dispatcher } from "undici";
import { ProxyAgent, fetch as undiciFetch } from "undici";

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return fetch;
  }
  try {
    const agent = new ProxyAgent(proxy);
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
    runtime.log?.("discord: rest proxy enabled");
    return wrapFetchWithAbortSignal(fetcher);
  } catch (err) {
    runtime.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
    return fetch;
  }
}

/**
 * AsyncLocalStorage context used by the ALS-aware globalThis.fetch wrapper
 * installed by `ensureProxyFetchWrapper`.  Each call to
 * `applyProxyToRequestClient` provides its own `dispatcher` per async context,
 * so concurrent REST requests from different Carbon clients never interfere.
 */
const _proxyAls = new AsyncLocalStorage<{ dispatcher: Dispatcher }>();

/**
 * Installs a single ALS-aware wrapper over `globalThis.fetch` the first time
 * it is called.  Subsequent calls are no-ops.
 *
 * The wrapper behaves identically to the original fetch when no ALS context is
 * present.  When a `dispatcher` is stored in the current ALS context it
 * delegates to undici with that dispatcher, which is how
 * `applyProxyToRequestClient` routes Carbon REST traffic through the proxy
 * without touching global state during an await window.
 */
let _proxyWrapperInstalled = false;
function ensureProxyFetchWrapper(): void {
  if (_proxyWrapperInstalled) return;
  _proxyWrapperInstalled = true;
  const baseFetch = globalThis.fetch;
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const store = _proxyAls.getStore();
    if (store?.dispatcher) {
      return undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: store.dispatcher,
      }) as unknown as Promise<Response>;
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  (wrapped as typeof fetch & { __discordProxyWrapped: boolean }).__discordProxyWrapped = true;
  globalThis.fetch = wrapped;
}

/**
 * Patches `restClient.executeRequest` at the instance level so that Carbon's
 * built-in `RequestClient` (which calls `globalThis.fetch`) routes its
 * requests through the configured HTTP proxy.
 *
 * Carbon's `RequestClientOptions` has no `fetch` injection point, so we shadow
 * the private method on the specific instance.
 *
 * Rather than temporarily swapping `globalThis.fetch` around the `await`
 * (which creates a race window where unrelated concurrent fetches pick up the
 * Discord proxy dispatcher — CWE-362), this implementation uses
 * `AsyncLocalStorage` to scope the proxy dispatcher to the current async
 * context only.  The global wrapper delegates to undici only when an ALS
 * context with a `dispatcher` is present; all other fetch calls are unaffected.
 */
export function applyProxyToRequestClient(
  restClient: RequestClient,
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): void {
  const proxy = proxyUrl?.trim();
  if (!proxy) return;

  try {
    const agent = new ProxyAgent(proxy);

    // Install the ALS-aware globalThis.fetch wrapper once per process.
    ensureProxyFetchWrapper();

    type AnyRecord = Record<string, unknown>;
    const proto = Object.getPrototypeOf(restClient) as AnyRecord;
    const origExecute = proto["executeRequest"] as
      | ((request: AnyRecord) => Promise<unknown>)
      | undefined;
    if (typeof origExecute !== "function") {
      runtime.error?.(
        danger(
          "discord: unable to apply rest proxy to Carbon client (unexpected RequestClient shape)",
        ),
      );
      return;
    }

    // Shadow executeRequest on this specific instance (not the shared prototype)
    // so only this Carbon client's requests are proxied.
    (restClient as unknown as AnyRecord)["executeRequest"] = function (
      this: RequestClient,
      request: AnyRecord,
    ) {
      // Run origExecute inside an ALS context that supplies the proxy
      // dispatcher.  The ALS-aware globalThis.fetch wrapper reads this context,
      // so only fetches initiated by *this* executeRequest call go through the
      // proxy.  Concurrent calls from other clients or unrelated code are
      // completely unaffected.
      return _proxyAls.run({ dispatcher: agent }, () => origExecute.call(this, request));
    };

    runtime.log?.("discord: carbon rest proxy enabled");
  } catch (err) {
    runtime.error?.(danger(`discord: failed to apply rest proxy to Carbon client: ${String(err)}`));
  }
}
