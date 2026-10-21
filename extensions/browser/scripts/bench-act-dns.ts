/** Opt-in real-browser action/DNS workload. Run with Node and an isolated Chromium executable. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import http from "node:http";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { BrowserContext } from "playwright-core";
import type { BrowserBridge } from "../src/browser/bridge-server.js";

const { values } = parseArgs({
  options: {
    chromium: { type: "string" },
    output: { type: "string" },
    label: { type: "string", default: "current" },
    iterations: { type: "string", default: "5" },
    "source-root": { type: "string" },
  },
});
assert(!process.versions.bun, "Run this native Node DNS observation workload with Node.");
assert(
  values.chromium,
  "--chromium must name a Chromium executable; no existing browser profile is used.",
);
const iterations = Number(values.iterations);
assert(
  Number.isSafeInteger(iterations) && iterations >= 5 && iterations <= 100,
  "--iterations must be an integer from 5 through 100.",
);
const host = () => ({
  loadAverage: loadavg(),
  logicalCpus: availableParallelism(),
  freeMemoryBytes: freemem(),
  totalMemoryBytes: totalmem(),
  controllerRssBytes: process.memoryUsage().rss,
});
const quantile = (numbers: number[], q: number) =>
  numbers.toSorted((a, b) => a - b)[Math.ceil(numbers.length * q) - 1];
async function freePort() {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const workloadStarted = performance.now();
const hostBefore = host();
const cpuBefore = process.cpuUsage();
// openclaw-temp-dir: allow opt-in CLI proof owns and removes its isolated state/profile
const scratch = await fs.mkdtemp(
  path.join(resolvePreferredOpenClawTmpDir(), "openclaw-browser-act-dns-"),
);
process.env.OPENCLAW_STATE_DIR = path.join(scratch, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(scratch, "openclaw.json");
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, "{}");
const sourceRoot = path.resolve(
  values["source-root"] ?? fileURLToPath(new URL("../../../", import.meta.url)),
);
const browserModule = (name: string) =>
  pathToFileURL(path.join(sourceRoot, "extensions/browser/src/browser", name)).href;
const [
  { startBrowserBridgeServer, stopBrowserBridgeServer },
  { resolveBrowserConfig },
  { getPlaywrightCore },
] = await Promise.all([
  import(browserModule("bridge-server.ts")) as Promise<
    typeof import("../src/browser/bridge-server.js")
  >,
  import(browserModule("config.ts")) as Promise<typeof import("../src/browser/config.js")>,
  import(browserModule("playwright-core.runtime.ts")) as Promise<
    typeof import("../src/browser/playwright-core.runtime.js")
  >,
]);
const port = await freePort();
const cdpUrl = `http://127.0.0.1:${port}`;
const token = randomUUID();
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const dns: Array<{ hostname: string; durationMs: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    // Native Node DNS entries expose this documented detail; other entry types are not observed.
    const detail = (entry as typeof entry & { detail: { hostname?: string } }).detail;
    if (detail?.hostname) {
      dns.push({ hostname: detail.hostname, durationMs: entry.duration });
    }
  }
});
observer.observe({ entryTypes: ["dns"] });
let browser: BrowserContext | undefined;
let bridge: BrowserBridge | undefined;
try {
  browser = await getPlaywrightCore().chromium.launchPersistentContext(
    path.join(scratch, "profile"),
    {
      headless: true,
      executablePath: values.chromium,
      args: [
        `--remote-debugging-port=${port}`,
        ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      ],
    },
  );
  const page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  assert.equal(await page.title(), "Example Domain");
  const resolved = resolveBrowserConfig({
    enabled: true,
    evaluateEnabled: true,
    attachOnly: true,
    defaultProfile: "bench",
    profiles: { bench: { cdpUrl, attachOnly: true, color: "#123456" } },
  });
  bridge = await startBrowserBridgeServer({ resolved, authToken: token });
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(
      `${bridge!.baseUrl}${route}${route.includes("?") ? "&" : "?"}profile=bench`,
      {
        headers,
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert(result && typeof result === "object");
    return result as Record<string, unknown>;
  };
  const target = async (url: string) => {
    const response = await request("/tabs");
    assert(Array.isArray(response.tabs));
    const tab = response.tabs.find(
      (entry: unknown) => entry && typeof entry === "object" && "url" in entry && entry.url === url,
    );
    assert(tab && typeof tab === "object" && "targetId" in tab && typeof tab.targetId === "string");
    return tab.targetId;
  };
  const targetId = await target("https://example.com/");
  await lookup("example.com", { all: true });
  await setImmediate();
  assert(
    dns.some((entry) => entry.hostname === "example.com"),
    "Native Node DNS observer positive control failed.",
  );
  const sample = async (index: number) => {
    await setImmediate();
    dns.length = 0;
    const started = performance.now();
    const response = await request("/act", {
      kind: "evaluate",
      targetId,
      fn: "() => ({ title: document.title, url: location.href })",
    });
    const durationMs = performance.now() - started;
    await setImmediate();
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { title: "Example Domain", url: "https://example.com/" });
    assert.equal(response.url, "https://example.com/");
    const lookups = dns.filter((entry) => entry.hostname === "example.com");
    return {
      index,
      durationMs,
      hostnameLookups: lookups.length,
      dnsDurationMs: lookups.map((entry) => entry.durationMs),
      result: response.result,
      url: response.url,
    };
  };
  const firstAction = await sample(0);
  const coldStartToFirstActionCompletionMs = performance.now() - workloadStarted;
  const warm = [];
  for (let index = 1; index <= iterations; index++) {
    warm.push(await sample(index));
  }
  await page.goto("about:blank");
  const blankTarget = await target("about:blank");
  await setImmediate();
  dns.length = 0;
  const blank = await request("/act", {
    kind: "evaluate",
    targetId: blankTarget,
    fn: "() => location.href",
  });
  await setImmediate();
  assert.equal(blank.result, "about:blank");
  assert.equal(dns.filter((entry) => entry.hostname === "example.com").length, 0);
  const report = {
    label: values.label,
    sourceRoot,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    browser: browser.browser()?.version(),
    ssrfPolicy: resolved.ssrfPolicy,
    hostBefore,
    hostAfter: host(),
    controllerCpuUsageMicros: process.cpuUsage(cpuBefore),
    workload:
      "Actual authenticated Browser Bridge HTTP /act through isolated Chrome CDP, unchanged public example.com page, native Node DNS PerformanceObserver; no DNS mock/delay, synthetic browser response or model.",
    firstAction,
    coldStartToFirstActionCompletionMs,
    warm,
    warmSummary: {
      count: warm.length,
      p50Ms: quantile(
        warm.map((row) => row.durationMs),
        0.5,
      ),
      p95Ms: quantile(
        warm.map((row) => row.durationMs),
        0.95,
      ),
      minMs: Math.min(...warm.map((row) => row.durationMs)),
      maxMs: Math.max(...warm.map((row) => row.durationMs)),
      hostnameLookups: warm.map((row) => row.hostnameLookups),
    },
    aboutBlankControl: { result: blank.result, hostnameLookups: 0 },
    limits:
      "Cold completion includes browser/page/bridge startup and one observer positive-control lookup. Action times include the real HTTP call/response parse, exclude observer flush. Controller CPU/RSS excludes Chrome. No meeting/audio loss or slow-resolver latency claim.",
  };
  if (values.output) {
    await fs.writeFile(values.output, JSON.stringify(report, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  observer.disconnect();
  try {
    if (bridge) {
      await stopBrowserBridgeServer(bridge.server);
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
}
