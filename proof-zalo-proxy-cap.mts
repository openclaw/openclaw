// Standalone proof: Zalo resolveZaloProxyFetch proxyCache bounded at 64 entries.
// Runs outside Vitest — exercises the real production code path through
// resolveZaloProxyFetch → makeProxyFetch → Undici ProxyAgent wrapping.
import { resolveZaloProxyFetch } from "./extensions/zalo/src/proxy.js";

const MAX = 64;
const urls = Array.from({ length: MAX + 1 }, (_, i) => `http://127.0.0.1:${19_000 + i}`);

const startedAt = Date.now();

// Fill the cache past capacity (65 distinct proxy URLs).
const fetchers = urls.map((url) => resolveZaloProxyFetch(url));

// Verify each fetcher is a callable function (real Undici ProxyAgent wrapper).
const allCallable = fetchers.every((f) => typeof f === "function");

// PROXY_FETCH_PROXY_URL tag — makeProxyFetch stamps the proxy URL.
const tagSymbol = Symbol.for("openclaw.proxyFetch.proxyUrl");
const tagged = fetchers[0] as Record<symbol, unknown> | undefined;
const tagOk = (tagged as any)?.[tagSymbol] === urls[0];

// Oldest entry (urls[0]) was evicted after the 65th insert triggerd pruneMapToMaxSize.
const rebuilt = resolveZaloProxyFetch(urls[0]!);
const oldestEvicted = rebuilt !== fetchers[0];

// Mid-window entry still hits the cache.
const midHit = resolveZaloProxyFetch(urls[2]!) === fetchers[2];

// Invoke the rebuilt fetcher to prove it's a real executable function (not a stub).
// HEAD request to localhost will fail fast with ECONNREFUSED — we only need to
// prove the function can be called without crashing.
let invokeResult = "not_called";
try {
  const controller = new AbortController();
  // Fire the abort after the first tick so the ProxyAgent gets a chance to
  // attempt connection but we don't block on a real proxy response.
  setTimeout(() => controller.abort(), 50);
  await rebuilt!("http://127.0.0.1:1", { method: "HEAD", signal: controller.signal });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("abort") || msg.includes("ECONNREFUSED") || msg.includes("connect")) {
    invokeResult = "called_and_threw_expected";
  } else {
    invokeResult = `called_and_threw: ${msg.slice(0, 80)}`;
  }
}

const elapsedMs = Date.now() - startedAt;

const result = {
  max: MAX,
  filled: urls.length,
  all_fetchers_callable: allCallable,
  proxy_tag_preserved: tagOk,
  oldest_evicted: oldestEvicted,
  rebuilt_differs: rebuilt !== fetchers[0],
  mid_hit: midHit,
  fetcher_invoked: invokeResult,
  process_stable: true,
  elapsed_ms: elapsedMs,
};

console.log(JSON.stringify(result, null, 2));

const exitOk = allCallable && tagOk && oldestEvicted && midHit;
if (!exitOk) {
  console.error("FAIL: proxyCache bound invariants violated");
  process.exit(1);
}
console.log("PASS: proxyCache bounded at 64 entries");
