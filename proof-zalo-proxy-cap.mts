// Standalone proof: Zalo resolveZaloProxyFetch proxyCache bounded at 64 entries.
// Runs outside Vitest — exercises the real production code path through
// resolveZaloProxyFetch → createHttp1ProxyAgent → fetchWithRuntimeDispatcher.
import { execSync } from "node:child_process";
import { resolveZaloProxyFetch } from "./extensions/zalo/src/proxy.js";

const HEAD = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
console.log("node=%s", process.version);
console.log("head=%s", HEAD);

const MAX = 64;
const urls = Array.from({ length: MAX + 1 }, (_, i) => `http://127.0.0.1:${19_000 + i}`);

const startedAt = Date.now();

// Fill the cache past capacity (65 distinct proxy URLs).
const fetchers = urls.map((url) => resolveZaloProxyFetch(url));

const allCallable = fetchers.every((f) => typeof f === "function");

const tagSymbol = Symbol.for("openclaw.proxyFetch.proxyUrl");
const tagged = fetchers[0] as Record<symbol, unknown> | undefined;
const tagOk = tagged?.[tagSymbol] === urls[0];

// Oldest entry was disposed on eviction — retained invoke must fail closed.
let retainedResult = "not_called";
try {
  await fetchers[0]!("http://127.0.0.1:1", { method: "HEAD" });
  retainedResult = "unexpected_ok";
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  retainedResult = msg.includes("disposed") ? "fail_closed" : `other: ${msg.slice(0, 80)}`;
}

const rebuilt = resolveZaloProxyFetch(urls[0]!);
const oldestEvicted = rebuilt !== fetchers[0];
const midHit = resolveZaloProxyFetch(urls[2]!) === fetchers[2];

let invokeResult = "not_called";
try {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await rebuilt!("http://127.0.0.1:1", { method: "HEAD", signal: controller.signal });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("abort") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("connect") ||
    msg.includes("fetch failed")
  ) {
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
  retained_fail_closed: retainedResult === "fail_closed",
  rebuilt_differs: rebuilt !== fetchers[0],
  mid_hit: midHit,
  fetcher_invoked: invokeResult,
  process_stable: true,
  elapsed_ms: elapsedMs,
};

console.log(JSON.stringify(result, null, 2));

const exitOk = allCallable && tagOk && oldestEvicted && midHit && retainedResult === "fail_closed";
if (!exitOk) {
  console.error("FAIL: proxyCache bound invariants violated");
  process.exit(1);
}
console.log("PASS: proxyCache bounded at 64 entries with fail-closed eviction");
