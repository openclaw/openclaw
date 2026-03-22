import type { RequestClient } from "@buape/carbon";
import { wrapFetchWithAbortSignal } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
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
 * Patches `restClient.executeRequest` at the instance level so that Carbon's
 * built-in `RequestClient` (which calls the module-level `globalThis.fetch`)
 * routes its requests through the configured HTTP proxy.
 *
 * Carbon's `RequestClientOptions` has no `fetch` injection point, so we shadow
 * the private method on the specific instance. The global-fetch swap window is
 * sub-millisecond for non-rate-limited calls (`waitForBucket` returns
 * synchronously when no bucket is active), making the risk of affecting
 * concurrent unrelated fetches negligible in practice.
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
    // No wrapFetchWithAbortSignal here — Carbon's RequestClient already manages
    // its own AbortController internally.
    const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;

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

    (restClient as unknown as AnyRecord)["executeRequest"] = async function (
      this: RequestClient,
      request: AnyRecord,
    ) {
      // Re-entrancy guard: if a concurrent call already installed proxyFetch,
      // skip the swap entirely. Without this guard, two interleaved calls can
      // permanently install proxyFetch as globalThis.fetch:
      //   Call A saves originalFetch, installs proxyFetch → yields
      //   Call B saves proxyFetch (!) as its savedFetch → yields
      //   Call A finally: restores originalFetch ✓
      //   Call B finally: restores proxyFetch ✗ (permanently installed)
      const alreadySwapped = globalThis.fetch === proxyFetch;
      const savedFetch = alreadySwapped ? undefined : globalThis.fetch;
      if (!alreadySwapped) globalThis.fetch = proxyFetch;
      try {
        return await origExecute.call(this, request);
      } finally {
        if (!alreadySwapped) globalThis.fetch = savedFetch!;
      }
    };

    runtime.log?.("discord: carbon rest proxy enabled");
  } catch (err) {
    runtime.error?.(danger(`discord: failed to apply rest proxy to Carbon client: ${String(err)}`));
  }
}
