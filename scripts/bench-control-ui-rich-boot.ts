import { readFile, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
} from "../src/gateway/control-ui-bootstrap-contract.ts";
import {
  installMockGateway,
  controlUiSessionUrl,
  controlUiBundledGatewayUrl,
  createControlUiMockBootstrapConfig,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { startControlUiBenchProxy } from "./lib/control-ui-bench-proxy.ts";
import { emulateNavigationWorkerNetwork } from "./lib/control-ui-navigation-network.ts";

// A small initial transcript isolates first-paint delays in optional rich renderers.
const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string" },
    "compare-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-rich-boot" },
    pairs: { type: "string", default: "20" },
    "network-latency-ms": { type: "string", default: "0" },
    "service-worker": { type: "boolean", default: false },
    http2: { type: "boolean", default: false },
    "compare-http2": { type: "boolean", default: false },
    "compare-delivery-hints": { type: "boolean", default: false },
    "typeface-profile": { type: "string", default: "claw" },
  },
});
if (!values["bundle-dir"] || !values["compare-bundle-dir"]) {
  throw new Error("bundle-dir and compare-bundle-dir are required");
}
const output = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
const base = path.resolve(values["bundle-dir"]);
const head = path.resolve(values["compare-bundle-dir"]);
const pairs = Number(values.pairs);
const networkLatencyMs = Number(values["network-latency-ms"]);
if (!["claw", "dash", "system"].includes(values["typeface-profile"])) {
  throw new Error("typeface-profile must be claw, dash, or system");
}
const typefacePreferences = {
  theme: values["typeface-profile"] === "dash" ? "dash" : "claw",
  themeMode: "light",
  ...(values["typeface-profile"] === "system" ? { fontUi: "system", fontChat: "system" } : {}),
};
if (
  !Number.isSafeInteger(pairs) ||
  pairs < 1 ||
  !Number.isFinite(networkLatencyMs) ||
  networkLatencyMs < 0
) {
  throw new Error("pairs must be a positive integer and network-latency-ms must be nonnegative");
}
const variants = [
  ["base", base],
  ["control", base],
  ["head", head],
] as const;
const sessionKey = "agent:main:dashboard:rich-risk-proof";
const finalText = "The completed rich run is ready.";
const activeText = "The active run is inspecting the synthetic layout.";
const now = Date.now();
const historyMessages = [
  { role: "user", content: "Inspect the synthetic layout.", timestamp: now - 5000 },
  {
    role: "assistant",
    content: "I will inspect the layout first.",
    phase: "commentary",
    runId: "completed-risk",
    timestamp: now - 4000,
  },
  {
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-layout",
    content: "Synthetic layout inspection complete.",
    runId: "completed-risk",
    timestamp: now - 3000,
  },
  {
    role: "assistant",
    content: finalText,
    phase: "final_answer",
    runId: "completed-risk",
    timestamp: now - 2000,
  },
  { role: "user", content: "Continue with the next synthetic check.", timestamp: now - 1000 },
];
await mkdir(output, { recursive: true });
const server = await startControlUiBenchGatewayServer(base);
const proxy =
  values.http2 || values["compare-http2"]
    ? await startControlUiBenchProxy(server.baseUrl)
    : undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let workerNetwork: Awaited<ReturnType<typeof emulateNavigationWorkerNetwork>> | undefined;
const results: unknown[] = [];
try {
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  if (values["service-worker"]) {
    workerNetwork = await emulateNavigationWorkerNetwork(browser, {
      latency: networkLatencyMs,
      downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
      uploadThroughput: -1,
    });
  }
  for (let pair = 0; pair < pairs; pair++) {
    for (const [variant, bundle] of variants) {
      const baseUrl =
        proxy && (!values["compare-http2"] || variant === "head") ? proxy.baseUrl : server.baseUrl;
      await server.selectBuild(bundle);
      server.setPreloadHeadersEnabled(!values["compare-delivery-hints"] || variant === "head");
      const source = await readFile(path.join(bundle, "sw.js"), "utf8");
      const buildId = /EMBEDDED_CACHE_VERSION = "([^"]+)"/.exec(source)![1]!;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        colorScheme: "light",
        serviceWorkers: values["service-worker"] ? "allow" : "block",
        ignoreHTTPSErrors: Boolean(proxy),
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const scenario = {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "synthetic-typography",
              configRevisionHash: "synthetic-typography",
              hash: "synthetic-typography",
              config: { ui: { prefs: typefacePreferences } },
              raw: JSON.stringify({ ui: { prefs: typefacePreferences } }),
              issues: [],
              valid: true,
            },
          },
          serverBuildId: buildId,
          sessionKey,
          historyMessages,
          inFlightRun: { runId: "active-risk", text: activeText, startedAt: now },
          sessionInfo: {
            key: sessionKey,
            hasActiveRun: true,
            activeRunIds: ["active-risk"],
            status: "running",
          },
        };
        server.setFixtureReader((pathname) =>
          pathname.endsWith(CONTROL_UI_BOOTSTRAP_CONFIG_PATH)
            ? {
                body: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
                contentType: "application/json",
              }
            : undefined,
        );
        await page.addInitScript(
          ({ gatewayUrl, prefs }) => {
            if (location.origin !== "null") {
              localStorage.setItem(
                `openclaw.control.settings.v1:${gatewayUrl}`,
                JSON.stringify({ gatewayUrl, ...prefs }),
              );
            }
          },
          { gatewayUrl: controlUiBundledGatewayUrl(baseUrl), prefs: typefacePreferences },
        );
        await installMockGateway(page, scenario);
        // HTTP interception disables the browser cache, including speculative
        // preload reuse. The isolated server owns the synthetic bootstrap read.
        await page.unrouteAll();
        const init = ({
          bootstrap,
          attribute,
          finalText: completedText,
          activeText: runningText,
        }: {
          bootstrap: string;
          attribute: string;
          finalText: string;
          activeText: string;
        }) => {
          const apply = () => {
            if (!document.documentElement) {
              return false;
            }
            document.documentElement.setAttribute(attribute, bootstrap);
            return true;
          };
          if (!apply()) {
            const observer = new MutationObserver(() => {
              if (apply()) {
                observer.disconnect();
              }
            });
            observer.observe(document, { childList: true });
          }
          const timings: Record<string, number> = {};
          Object.assign(window, { __richRiskReadiness: timings });
          timings.layoutShift = 0;
          new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
              if (!Reflect.get(entry, "hadRecentInput")) {
                timings.layoutShift += Reflect.get(entry, "value");
              }
            }
          }).observe({ type: "layout-shift", buffered: true });
          const visible = (node: Element) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < innerHeight &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const check = () => {
            const composer = document.querySelector<HTMLTextAreaElement>(
              ".agent-chat__composer-combobox textarea",
            );
            if (!timings.composerMs && composer && !composer.disabled && visible(composer)) {
              timings.composerMs = performance.now();
            }
            for (const bubble of document.querySelectorAll("section.chat .chat-text")) {
              if (!visible(bubble)) {
                continue;
              }
              if (!timings.finalMs && bubble.textContent?.includes(completedText)) {
                timings.finalMs = performance.now();
              }
              if (!timings.activeMs && bubble.textContent?.includes(runningText)) {
                timings.activeMs = performance.now();
              }
            }
            if (!timings.composerMs || !timings.finalMs || !timings.activeMs) {
              requestAnimationFrame(check);
            }
          };
          requestAnimationFrame(check);
        };
        const initOptions = {
          bootstrap: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
          attribute: CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
          finalText,
          activeText,
        };
        await page.addInitScript({
          content: `;(() => { const __name = (fn) => fn; (${init.toString()})(${JSON.stringify(initOptions)}); })();`,
        });
        const cdp = await context.newCDPSession(page);
        const responses: Array<{
          url: string;
          protocol?: string;
          connectionId?: number;
          status: number;
          fromServiceWorker: boolean;
          headers: Record<string, string>;
        }> = [];
        cdp.on("Network.responseReceived", ({ response }) => {
          responses.push({
            url: response.url,
            protocol: response.protocol,
            connectionId: response.connectionId,
            status: response.status,
            fromServiceWorker: response.fromServiceWorker ?? false,
            headers: Object.fromEntries(
              Object.entries(response.headers)
                .filter(([name]) => /^(cache-control|content-encoding|vary|link)$/i.test(name))
                .map(([name, value]) => [name.toLowerCase(), value]),
            ),
          });
        });
        const earlyHints: unknown[] = [];
        cdp.on("Network.responseReceivedEarlyHints", (event) => earlyHints.push(event));
        await cdp.send("Network.enable");
        let workerSetup:
          | { scriptUrl?: string; navigationPreloadEnabled?: boolean; nativeAuthRequests?: number }
          | undefined;
        if (values["service-worker"]) {
          await page.goto(controlUiSessionUrl(baseUrl, sessionKey));
          await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
          workerSetup = await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready;
            return {
              scriptUrl: registration.active?.scriptURL,
              navigationPreloadEnabled: (await registration.navigationPreload?.getState())?.enabled,
            };
          });
          const nativeAuthUrl = new URL(controlUiSessionUrl(baseUrl, sessionKey));
          nativeAuthUrl.searchParams.set("openclaw_http_auth", "1");
          server.requests.length = 0;
          await page.goto(nativeAuthUrl.href);
          workerSetup.nativeAuthRequests = server.requests.filter(
            (request) => request.url === nativeAuthUrl.pathname + nativeAuthUrl.search,
          ).length;
          if (workerSetup.nativeAuthRequests !== 1) {
            throw new Error(
              `Native auth navigation sent ${workerSetup.nativeAuthRequests} requests`,
            );
          }
          // Retire the warm document before stopping its worker: its resume and
          // offline-cache probes must not restart it during cold-state setup.
          await page.goto("about:blank");
          // Own browser/profile only: exercise a stopped worker with cold assets.
          await cdp.send("ServiceWorker.enable");
          await cdp.send("ServiceWorker.stopAllWorkers");
          await cdp.send("Storage.clearDataForOrigin", {
            origin: baseUrl,
            storageTypes: "cache_storage,indexeddb,local_storage",
          });
        }
        await cdp.send("Network.clearBrowserCache");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: networkLatencyMs,
          downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
          uploadThroughput: -1,
        });
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        const before = (await cdp.send("Performance.getMetrics")).metrics;
        const hostLoad = loadavg();
        responses.length = 0;
        earlyHints.length = 0;
        server.requests.length = 0;
        const workerRequestStart = workerNetwork?.snapshot().requests.length ?? 0;
        await page.goto(controlUiSessionUrl(baseUrl, sessionKey), {
          waitUntil: "domcontentloaded",
        });
        if (!(await page.evaluate(() => Reflect.has(window, "__richRiskReadiness")))) {
          throw new Error(`Readiness initializer failed: ${errors.join("; ")}`);
        }
        await page.waitForFunction(
          () => {
            const readiness = Reflect.get(window, "__richRiskReadiness");
            return readiness?.composerMs && readiness?.finalMs && readiness?.activeMs;
          },
          undefined,
          { timeout: 30000 },
        );
        const after = (await cdp.send("Performance.getMetrics")).metrics;
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        workerNetwork?.assertHealthy();
        const data = await page.evaluate(() => ({
          readiness: Reflect.get(window, "__richRiskReadiness"),
          navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
          resources: performance.getEntriesByType("resource").map((entry) => ({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            fetchStart: Reflect.get(entry, "fetchStart"),
            domainLookupStart: Reflect.get(entry, "domainLookupStart"),
            domainLookupEnd: Reflect.get(entry, "domainLookupEnd"),
            connectStart: Reflect.get(entry, "connectStart"),
            connectEnd: Reflect.get(entry, "connectEnd"),
            requestStart: Reflect.get(entry, "requestStart"),
            responseStart: Reflect.get(entry, "responseStart"),
            responseEnd: Reflect.get(entry, "responseEnd"),
            nextHopProtocol: Reflect.get(entry, "nextHopProtocol"),
            encodedBodySize: Reflect.get(entry, "encodedBodySize"),
            decodedBodySize: Reflect.get(entry, "decodedBodySize"),
            transferSize: Reflect.get(entry, "transferSize"),
            initiatorType: Reflect.get(entry, "initiatorType"),
          })),
        }));
        const cpu = Object.fromEntries(
          ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map((key) => [
            key,
            1000 *
              (after.find((metric) => metric.name === key)!.value -
                before.find((metric) => metric.name === key)!.value),
          ]),
        );
        const documentPath = new URL(controlUiSessionUrl(baseUrl, sessionKey)).pathname;
        const documentRequests = server.requests.filter((request) => request.url === documentPath);
        if (documentRequests.length !== 1) {
          throw new Error(`Expected one document request, received ${documentRequests.length}`);
        }
        results.push({
          pair,
          variant,
          buildId,
          hostLoad,
          ...data,
          responses,
          earlyHints,
          requests: [...server.requests],
          workerRequests: workerNetwork?.snapshot().requests.slice(workerRequestStart),
          workerSetup,
          cpu,
          errors,
        });
        await writeFile(
          path.join(output, "summary.json"),
          JSON.stringify(
            {
              workload: "cold initial completed+active rich run",
              base,
              head,
              pairs,
              networkLatencyMs,
              serviceWorker: values["service-worker"],
              http2: values.http2,
              compareHttp2: values["compare-http2"],
              compareDeliveryHints: values["compare-delivery-hints"],
              typefaceProfile: values["typeface-profile"],
              results,
            },
            null,
            2,
          ),
        );
        if (pair === 0) {
          await page.screenshot({ path: path.join(output, `${variant}.png`) });
        }
        console.log(
          JSON.stringify({ pair, variant, hostLoad, readiness: data.readiness, cpu, errors }),
        );
        if (errors.length) {
          throw new Error(errors.join("\n"));
        }
      } catch (error) {
        await page.screenshot({ path: path.join(output, `${variant}-${pair}-failure.png`) });
        await writeFile(
          path.join(output, `${variant}-${pair}-failure.json`),
          JSON.stringify(
            {
              errors,
              browser: await page.evaluate(() => ({
                readiness: Reflect.get(window, "__richRiskReadiness"),
                text: document.querySelector("section.chat")?.textContent,
              })),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await context.close();
      }
    }
  }
} finally {
  try {
    try {
      await workerNetwork?.close();
    } finally {
      await browser?.close();
    }
  } finally {
    await proxy?.close();
    await server.close();
  }
}
