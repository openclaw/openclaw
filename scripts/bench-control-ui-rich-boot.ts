import { readFile, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit, type Page } from "playwright";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
} from "../src/gateway/control-ui-bootstrap-contract.ts";
import {
  installMockGateway,
  controlUiSessionUrl,
  controlUiBundledGatewayUrl,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  resolvePlaywrightChromiumExecutablePath,
  type MockGatewayWindow,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { startControlUiBenchProxy } from "./lib/control-ui-bench-proxy.ts";
import { emulateNavigationWorkerNetwork } from "./lib/control-ui-navigation-network.ts";

// A small initial transcript isolates first-paint delays in optional rich renderers.
const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string" },
    "compare-bundle-dir": { type: "string" },
    "previous-bundle-dir": { type: "string" },
    "previous-compare-bundle-dir": { type: "string" },
    "boot-state": { type: "string" },
    "boot-route": { type: "string", default: "chat" },
    engines: { type: "string" },
    "observe-after-ready-ms": { type: "string", default: "3000" },
    output: { type: "string", default: ".artifacts/control-ui-rich-boot" },
    pairs: { type: "string", default: "20" },
    "network-latency-ms": { type: "string", default: "0" },
    "service-worker": { type: "boolean", default: false },
    "warm-reload": { type: "boolean", default: false },
    http2: { type: "boolean", default: false },
    "compare-http2": { type: "boolean", default: false },
    "compare-delivery-hints": { type: "boolean", default: false },
    "typeface-profile": { type: "string", default: "claw" },
  },
});
if (!values["bundle-dir"] || !values["compare-bundle-dir"]) {
  throw new Error("bundle-dir and compare-bundle-dir are required");
}
if (!values["boot-state"] && values["warm-reload"] && values["service-worker"]) {
  throw new Error("warm-reload cannot be combined with service-worker");
}
const bootRoute = values["boot-route"];
if (bootRoute !== "chat" && bootRoute !== "new") {
  throw new Error("boot-route must be chat or new");
}
const bootUrl = (baseUrl: string) =>
  bootRoute === "new" ? new URL("/new", baseUrl).href : controlUiSessionUrl(baseUrl, sessionKey);
const output = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
const base = path.resolve(values["bundle-dir"]);
const head = path.resolve(values["compare-bundle-dir"]);
const previous = values["previous-bundle-dir"]
  ? path.resolve(values["previous-bundle-dir"])
  : undefined;
const previousHead = values["previous-compare-bundle-dir"]
  ? path.resolve(values["previous-compare-bundle-dir"])
  : previous;
const bootStates = (values["boot-state"] ?? (values["warm-reload"] ? "warm" : "cold")).split(",");
if (bootStates.some((state) => !["cold", "warm", "updated"].includes(state))) {
  throw new Error("boot-state must be a comma-separated list of cold, warm, updated");
}
if (bootStates.includes("updated") && !previous) {
  throw new Error("updated boot requires previous-bundle-dir");
}
if (
  values["boot-state"] &&
  values["warm-reload"] &&
  !bootStates.every((state) => state === "warm")
) {
  throw new Error("warm-reload conflicts with boot-state");
}
const engines = (values.engines ?? "chromium").split(",");
if (engines.some((engine) => !["chromium", "webkit", "firefox"].includes(engine))) {
  throw new Error("engines must be a comma-separated list of chromium, webkit, firefox");
}
// Preserve historical CDP profiles only for the existing Chromium-only invocation.
const legacyProfile = !values["boot-state"] && !values.engines;
const observeAfterReadyMs = Number(values["observe-after-ready-ms"]);
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
  networkLatencyMs < 0 ||
  !Number.isFinite(observeAfterReadyMs) ||
  observeAfterReadyMs < 0
) {
  throw new Error(
    "pairs must be a positive integer and latency/observation durations must be nonnegative",
  );
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
async function bundleInfo(bundle: string) {
  const source = await readFile(path.join(bundle, "sw.js"), "utf8");
  const buildId = /EMBEDDED_CACHE_VERSION = "([^"]+)"/.exec(source)?.[1];
  if (!buildId) {
    throw new Error(`Missing build identity in ${bundle}/sw.js`);
  }
  const offline = JSON.parse(/^const OFFLINE_BOOT = (.+);$/m.exec(source)?.[1] ?? "null") as {
    id: string;
    assets: Array<{ path: string }>;
  } | null;
  return {
    buildId,
    cacheName: `openclaw-control-${buildId}${offline ? `-${offline.id}` : ""}`,
    bootAssets: offline?.assets.map((asset) => asset.path) ?? [],
  };
}

async function workerState(page: Page, expected: Awaited<ReturnType<typeof bundleInfo>>) {
  return await page.evaluate(async (expectedBuild) => {
    if (!("serviceWorker" in navigator)) {
      return { supported: false };
    }
    const registration = await navigator.serviceWorker.getRegistration();
    const cacheEntries = await Promise.all(
      (await caches.keys()).map(async (name) => ({
        name,
        urls: (await (await caches.open(name)).keys()).map((request) => request.url),
      })),
    );
    const currentCache = cacheEntries.find((entry) => entry.name === expectedBuild.cacheName);
    const scope = registration?.scope ?? new URL(".", document.baseURI).href;
    return {
      expectedBuildId: expectedBuild.buildId,
      expectedCacheName: expectedBuild.cacheName,
      hasCompleteOfflineShell:
        currentCache?.urls.some((url) => new URL(url).pathname.endsWith("/__offline_shell__")) ??
        false,
      bootAssetCount: expectedBuild.bootAssets.length,
      bootAssetsCached: expectedBuild.bootAssets.filter((url) =>
        currentCache?.urls.includes(new URL(url, scope).href),
      ).length,
      supported: true,
      controller: navigator.serviceWorker.controller
        ? {
            scriptUrl: navigator.serviceWorker.controller.scriptURL,
            state: navigator.serviceWorker.controller.state,
          }
        : null,
      active: registration?.active
        ? {
            scriptUrl: registration.active.scriptURL,
            state: registration.active.state,
          }
        : null,
      installing: registration?.installing
        ? {
            scriptUrl: registration.installing.scriptURL,
            state: registration.installing.state,
          }
        : null,
      waiting: registration?.waiting
        ? {
            scriptUrl: registration.waiting.scriptURL,
            state: registration.waiting.state,
          }
        : null,
      navigationPreloadEnabled: registration?.navigationPreload
        ? (await registration.navigationPreload.getState()).enabled
        : undefined,
      caches: cacheEntries,
    };
  }, expected);
}

try {
  for (const engine of engines) {
    const browserType = { chromium, webkit, firefox }[engine as "chromium" | "webkit" | "firefox"];
    browser = await browserType.launch({
      headless: true,
      ...(engine === "chromium"
        ? {
            executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
          }
        : {}),
    });
    server.setAssetLatencyMs(legacyProfile ? 0 : networkLatencyMs);
    if (legacyProfile && values["service-worker"]) {
      workerNetwork = await emulateNavigationWorkerNetwork(browser, {
        latency: networkLatencyMs,
        downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
        uploadThroughput: -1,
      });
    }
    for (let pair = 0; pair < pairs; pair++) {
      const orderedStates = bootStates.map(
        (_, index) => bootStates[(index + pair) % bootStates.length]!,
      );
      const orderedVariants = legacyProfile
        ? variants
        : variants.map((_, index) => variants[(index + pair) % variants.length]!);
      for (const bootState of orderedStates) {
        for (const [variant, bundle] of orderedVariants) {
          const baseUrl =
            proxy && (!values["compare-http2"] || variant === "head")
              ? proxy.baseUrl
              : server.baseUrl;
          await server.selectBuild(bundle);
          server.setPreloadHeadersEnabled(!values["compare-delivery-hints"] || variant === "head");
          const captureName = legacyProfile ? variant : `${engine}-${bootState}-${variant}`;
          const currentBuild = await bundleInfo(bundle);
          const buildId = currentBuild.buildId;
          let servedBuildId = buildId;
          const context = await browser.newContext({
            viewport: { width: 1440, height: 1100 },
            colorScheme: "light",
            serviceWorkers: values["service-worker"] ? "allow" : "block",
            ignoreHTTPSErrors: Boolean(proxy),
          });
          const page = await context.newPage();
          let diagnosticBuild = currentBuild;
          const errors: string[] = [];
          const consoleMessages: Array<{ type: string; text: string }> = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            const configurePage = async (targetPage: Page, pageBuildId: string) => {
              servedBuildId = pageBuildId;
              targetPage.on("console", (message) => {
                if (["warning", "error"].includes(message.type()) && consoleMessages.length < 20) {
                  consoleMessages.push({ type: message.type(), text: message.text() });
                }
              });
              const scenario = {
                // This benchmark observes its own enabled-composer/content boundary.
                awaitInitialRoster: legacyProfile,
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
                serverBuildId: pageBuildId,
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
                !legacyProfile && pathname === "/healthz"
                  ? {
                      body: JSON.stringify({ ok: true, status: "live" }),
                      contentType: "application/json",
                    }
                  : pathname.endsWith(CONTROL_UI_BOOTSTRAP_CONFIG_PATH)
                    ? {
                        body: JSON.stringify({
                          ...createControlUiMockBootstrapConfig(scenario),
                          serverBuildId: servedBuildId,
                        }),
                        contentType: "application/json",
                      }
                    : undefined,
              );
              await targetPage.addInitScript(
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
              if (legacyProfile) {
                await installMockGateway(targetPage, scenario);
                await targetPage.unrouteAll();
              } else {
                // HTTP routing disables browser caches; the server owns bootstrap delivery.
                await targetPage.addInitScript({
                  content: createControlUiMockGatewayInitScript(scenario),
                });
              }
              const init = ({
                bootstrap,
                attribute,
                finalText: completedText,
                activeText: runningText,
                route,
                trackFontReady,
              }: {
                bootstrap: string;
                attribute: string;
                finalText: string;
                activeText: string;
                route: string;
                trackFontReady: boolean;
              }) => {
                const nextBuildId =
                  location.origin !== "null"
                    ? sessionStorage.getItem("openclaw.control-ui-e2e.serverBuildId")
                    : null;
                const bootstrapJson = nextBuildId
                  ? JSON.stringify({ ...JSON.parse(bootstrap), serverBuildId: nextBuildId })
                  : bootstrap;
                const apply = () => {
                  if (!document.documentElement) {
                    return false;
                  }
                  document.documentElement.setAttribute(attribute, bootstrapJson);
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
                const workerEvents: Array<{ type: string; time: number; version?: unknown }> = [];
                Object.assign(window, {
                  __richRiskReadiness: timings,
                  __richRiskWorkerEvents: workerEvents,
                });
                if ("serviceWorker" in navigator) {
                  navigator.serviceWorker.addEventListener("controllerchange", () => {
                    workerEvents.push({ type: "controllerchange", time: performance.now() });
                  });
                  navigator.serviceWorker.addEventListener("message", (event) => {
                    if (event.data?.type === "sw-updated") {
                      workerEvents.push({
                        type: "sw-updated",
                        time: performance.now(),
                        version: event.data.version,
                      });
                    }
                  });
                }
                if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) {
                  timings.layoutShift = 0;
                  new PerformanceObserver((entries) => {
                    for (const entry of entries.getEntries()) {
                      if (!Reflect.get(entry, "hadRecentInput")) {
                        timings.layoutShift += Reflect.get(entry, "value");
                      }
                    }
                  }).observe({ type: "layout-shift", buffered: true });
                }
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
                    route === "new"
                      ? ".new-session-page__composer textarea"
                      : ".agent-chat__composer-combobox textarea",
                  );
                  if (!timings.composerMs && composer && !composer.disabled && visible(composer)) {
                    timings.composerMs = performance.now();
                    if (route === "new") {
                      timings.routeReadyMs = timings.composerMs;
                    }
                  }
                  if (route !== "new") {
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
                  }
                  const contentReady =
                    timings.composerMs &&
                    (route === "new" || (timings.finalMs && timings.activeMs));
                  if (!contentReady) {
                    requestAnimationFrame(check);
                  } else if (trackFontReady) {
                    void document.fonts.ready.then(() => {
                      timings.fontsReadyMs = performance.now();
                      // This promise starts after every content boundary has been observed.
                      timings.usableMs = timings.fontsReadyMs;
                    });
                  }
                };
                requestAnimationFrame(check);
              };
              const initOptions = {
                bootstrap: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
                attribute: CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
                finalText,
                activeText,
                route: bootRoute,
                trackFontReady: !legacyProfile,
              };
              await targetPage.addInitScript({
                content: `;(() => { const __name = (fn) => fn; (${init.toString()})(${JSON.stringify(initOptions)}); })();`,
              });
            };
            if (bootState !== "updated") {
              await configurePage(page, buildId);
            }
            const waitForReadiness = async (targetPage: Page, expectedBuildId: string) => {
              let deadline: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  targetPage.waitForFunction(
                    ({ route, fonts, targetBuildId, expectedPath }) => {
                      const readiness = Reflect.get(window, "__richRiskReadiness");
                      return (
                        location.pathname === expectedPath &&
                        globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO?.buildId === targetBuildId &&
                        readiness?.composerMs &&
                        (route === "new" || (readiness?.finalMs && readiness?.activeMs)) &&
                        (!fonts || readiness.usableMs)
                      );
                    },
                    {
                      route: bootRoute,
                      fonts: !legacyProfile,
                      targetBuildId: expectedBuildId,
                      expectedPath: new URL(bootUrl(baseUrl)).pathname,
                    },
                    { timeout: 30000 },
                  ),
                  new Promise((_, reject) => {
                    deadline = setTimeout(
                      () => reject(new Error("Application readiness exceeded 30 seconds")),
                      30000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(deadline);
              }
              const renderedBuildId = await targetPage.evaluate(
                () => globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO?.buildId,
              );
              if (renderedBuildId !== expectedBuildId) {
                throw new Error(
                  `Rendered build ${renderedBuildId} does not match expected build ${expectedBuildId}`,
                );
              }
            };
            const cdp = engine === "chromium" ? await context.newCDPSession(page) : undefined;
            const responses: Array<{
              url: string;
              protocol?: string;
              connectionId?: number;
              status: number;
              fromServiceWorker: boolean;
              headers: Record<string, string>;
            }> = [];
            cdp?.on("Network.responseReceived", ({ response }) => {
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
            cdp?.on("Network.responseReceivedEarlyHints", (event) => earlyHints.push(event));
            await cdp?.send("Network.enable");
            let workerSetup:
              | {
                  scriptUrl?: string;
                  navigationPreloadEnabled?: boolean;
                  nativeAuthRequests?: number;
                }
              | undefined;
            if (legacyProfile && values["service-worker"]) {
              await page.goto(bootUrl(baseUrl));
              await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
              workerSetup = await page.evaluate(async () => {
                const registration = await navigator.serviceWorker.ready;
                return {
                  scriptUrl: registration.active?.scriptURL,
                  navigationPreloadEnabled: (await registration.navigationPreload?.getState())
                    ?.enabled,
                };
              });
              const nativeAuthUrl = new URL(bootUrl(baseUrl));
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
              await cdp?.send("ServiceWorker.enable");
              await cdp?.send("ServiceWorker.stopAllWorkers");
              await cdp?.send("Storage.clearDataForOrigin", {
                origin: baseUrl,
                storageTypes: "cache_storage,indexeddb,local_storage",
              });
            }
            if (legacyProfile) {
              await cdp?.send("Network.clearBrowserCache");
              await cdp?.send("Network.setCacheDisabled", { cacheDisabled: false });
              await cdp?.send("Network.emulateNetworkConditions", {
                offline: false,
                latency: networkLatencyMs,
                downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
                uploadThroughput: -1,
              });
            }
            let workerBefore;
            let transitionStartedAtEpochMs: number | undefined;
            if (bootState === "warm" || bootState === "updated") {
              let primeBuild = currentBuild;
              if (bootState === "updated") {
                const primeBundle = variant === "head" ? previousHead! : previous!;
                await server.selectBuild(primeBundle);
                primeBuild = await bundleInfo(primeBundle);
                diagnosticBuild = primeBuild;
                await configurePage(page, primeBuild.buildId);
              }
              await page.bringToFront();
              await page.goto(bootUrl(baseUrl), {
                waitUntil: "domcontentloaded",
              });
              await waitForReadiness(page, primeBuild.buildId);
              if (legacyProfile) {
                await page.evaluate(() => document.fonts.ready.then(() => undefined));
              }
              if (values["service-worker"]) {
                console.log(
                  JSON.stringify({ engine, bootState, variant, phase: "prime-content-ready" }),
                );
                let controllerDeadline: ReturnType<typeof setTimeout> | undefined;
                const controlled = Promise.race([
                  page.waitForFunction(
                    () => navigator.serviceWorker.controller !== null,
                    undefined,
                    { timeout: 65000 },
                  ),
                  new Promise((_, reject) => {
                    controllerDeadline = setTimeout(
                      () =>
                        reject(
                          new Error(
                            "Service worker did not control the prime after its 60-second install budget",
                          ),
                        ),
                      65000,
                    );
                  }),
                ]).finally(() => clearTimeout(controllerDeadline));
                let workerDeadline: ReturnType<typeof setTimeout> | undefined;
                const ready = await Promise.race([
                  controlled.then(() => true),
                  new Promise<boolean>((resolve) => {
                    workerDeadline = setTimeout(() => resolve(false), 30000);
                  }),
                ]).finally(() => clearTimeout(workerDeadline));
                if (!ready) {
                  await writeFile(
                    path.join(output, `${captureName}-${pair}-worker-wait.json`),
                    JSON.stringify(
                      {
                        worker: await Promise.race([
                          workerState(page, primeBuild),
                          new Promise((resolve) => {
                            setTimeout(() => resolve({ timeout: true }), 5000);
                          }),
                        ]),
                        requests: server.requests,
                        consoleMessages,
                      },
                      null,
                      2,
                    ),
                  );
                }
                await controlled;
              }
              // Give warm/updated visits the same settled prime, including optional downloads.
              if (!legacyProfile || values["service-worker"]) {
                await page.waitForTimeout(observeAfterReadyMs);
              }
              if (values["service-worker"]) {
                workerBefore = await workerState(page, primeBuild);
              }
              if (bootState === "updated") {
                diagnosticBuild = currentBuild;
                server.requests.length = 0;
                transitionStartedAtEpochMs = await page.evaluate(
                  () => performance.timeOrigin + performance.now(),
                );
                await page.evaluate((nextBuildId) => {
                  (window as MockGatewayWindow).openclawControlUiE2eGateway!.setServerBuildId(
                    nextBuildId,
                  );
                }, buildId);
                servedBuildId = buildId;
                await server.selectBuild(bundle);
              }
            }
            await page.bringToFront();
            await cdp?.send("Performance.enable", { timeDomain: "threadTicks" });
            const before = (await cdp?.send("Performance.getMetrics"))?.metrics;
            const hostLoad = loadavg();
            responses.length = 0;
            earlyHints.length = 0;
            if (bootState !== "updated") {
              server.requests.length = 0;
            }
            const workerRequestStart = workerNetwork?.snapshot().requests.length ?? 0;
            let navigationInterruption: string | undefined;
            if (bootState === "warm") {
              await page.reload({ waitUntil: "domcontentloaded" });
            } else {
              try {
                await page.goto(bootUrl(baseUrl), {
                  waitUntil: "domcontentloaded",
                });
              } catch (error) {
                if (bootState !== "updated") {
                  throw error;
                }
                // Retired A chunks can start the product's recovery navigation during this visit.
                navigationInterruption = String(error);
              }
            }
            await waitForReadiness(page, buildId);
            const legacyCpu = legacyProfile
              ? (await cdp?.send("Performance.getMetrics"))?.metrics
              : undefined;
            const legacyRequests = legacyProfile ? [...server.requests] : undefined;
            if (legacyProfile) {
              await page.evaluate(async () => {
                await document.fonts.ready;
                const readiness = Reflect.get(window, "__richRiskReadiness");
                readiness.fontsReadyMs = performance.now();
                readiness.usableMs = Math.max(
                  readiness.composerMs,
                  readiness.finalMs ?? 0,
                  readiness.activeMs ?? 0,
                  readiness.fontsReadyMs,
                );
              });
            }
            const after = legacyCpu ?? (await cdp?.send("Performance.getMetrics"))?.metrics;
            const requestsAtReady = legacyRequests ?? [...server.requests];
            const readyRequestCount = requestsAtReady.length;
            workerNetwork?.assertHealthy();
            const data = await page.evaluate(() => ({
              timeOrigin: performance.timeOrigin,
              readiness: Reflect.get(window, "__richRiskReadiness"),
              visibility: document.visibilityState,
              renderedBuildId: globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO?.buildId,
              workerEvents: Reflect.get(window, "__richRiskWorkerEvents"),
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
            const cpu =
              before && after
                ? Object.fromEntries(
                    ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
                      (key) => [
                        key,
                        1000 *
                          (after.find((metric) => metric.name === key)!.value -
                            before.find((metric) => metric.name === key)!.value),
                      ],
                    ),
                  )
                : undefined;
            const workerAtReady = values["service-worker"]
              ? await workerState(page, currentBuild)
              : undefined;
            if (values["service-worker"] && !legacyProfile) {
              await page.waitForTimeout(observeAfterReadyMs);
            }
            const workerAfter = values["service-worker"]
              ? await workerState(page, currentBuild)
              : undefined;
            const documentPath = new URL(bootUrl(baseUrl)).pathname;
            const documentRequests = server.requests.filter(
              (request) =>
                new URL(request.url, baseUrl).pathname === documentPath && request.method === "GET",
            );
            if (
              documentRequests.length < 1 ||
              (bootState !== "updated" && documentRequests.length !== 1)
            ) {
              throw new Error(
                `Unexpected document request count: ${documentRequests.length} (${bootState})`,
              );
            }
            const recoveryObserved = Boolean(navigationInterruption) || documentRequests.length > 1;
            const navigationPrefixMs =
              transitionStartedAtEpochMs === undefined
                ? undefined
                : data.timeOrigin - transitionStartedAtEpochMs;
            const transitionElapsedMs =
              navigationPrefixMs === undefined
                ? undefined
                : navigationPrefixMs + data.readiness.usableMs;
            results.push({
              pair,
              variant,
              engine,
              bootState,
              buildId,
              hostLoad,
              ...data,
              responses,
              earlyHints,
              requests: requestsAtReady,
              requestsAfterReady: server.requests.slice(readyRequestCount),
              navigationInterruption,
              recoveryObserved,
              transitionStartedAtEpochMs,
              navigationPrefixMs,
              transitionElapsedMs,
              documentRequests: documentRequests.length,
              documentHeadRequests: server.requests.filter(
                (request) =>
                  request.method === "HEAD" &&
                  [documentPath, "/index.html"].includes(new URL(request.url, baseUrl).pathname),
              ).length,
              workerBefore,
              workerAtReady,
              workerAfter,
              afterObservation: await page.evaluate(() => ({
                readiness: Reflect.get(window, "__richRiskReadiness"),
                workerEvents: Reflect.get(window, "__richRiskWorkerEvents"),
                navigation: performance
                  .getEntriesByType("navigation")
                  .map((entry) => entry.toJSON()),
              })),
              workerRequests: workerNetwork?.snapshot().requests.slice(workerRequestStart),
              workerSetup,
              cpu: recoveryObserved ? undefined : cpu,
              errors,
              consoleMessages,
            });
            await writeFile(
              path.join(output, "summary.json"),
              JSON.stringify(
                {
                  bootRoute,
                  workload:
                    bootRoute === "new"
                      ? "New Session enabled composer"
                      : legacyProfile
                        ? values["warm-reload"]
                          ? "warm reload completed+active rich run"
                          : "cold initial completed+active rich run"
                        : "completed+active rich run",
                  bootStates,
                  engines,
                  previous,
                  previousHead,
                  networkProfile: legacyProfile
                    ? "legacy CDP RTT and 10 Mbps"
                    : "server response delay, no throughput cap",
                  observeAfterReadyMs,
                  primeDwellMs: legacyProfile ? undefined : observeAfterReadyMs,
                  base,
                  head,
                  pairs,
                  networkLatencyMs,
                  serviceWorker: values["service-worker"],
                  warmReload: values["warm-reload"],
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
              await page.screenshot({
                path: path.join(output, `${captureName}.png`),
              });
            }
            console.log(
              JSON.stringify({
                pair,
                variant,
                engine,
                bootState,
                hostLoad,
                readiness: data.readiness,
                navigationInterruption,
                recoveryObserved,
                navigationPrefixMs,
                transitionElapsedMs,
                cpu: recoveryObserved ? undefined : cpu,
                errors,
              }),
            );
            if (errors.length) {
              throw new Error(errors.join("\n"));
            }
          } catch (error) {
            await page
              .screenshot({
                path: path.join(output, `${captureName}-${pair}-failure.png`),
                timeout: 5000,
              })
              .catch(() => undefined);
            await writeFile(
              path.join(output, `${captureName}-${pair}-failure.json`),
              JSON.stringify(
                {
                  errors,
                  consoleMessages,
                  requests: [...server.requests],
                  worker: await Promise.race([
                    workerState(page, diagnosticBuild),
                    new Promise((resolve) => {
                      setTimeout(() => resolve({ timeout: true }), 5000);
                    }),
                  ]).catch((failure: unknown) => ({ failure: String(failure) })),
                  browser: await Promise.race([
                    page.evaluate(() => ({
                      readiness: Reflect.get(window, "__richRiskReadiness"),
                      visibility: document.visibilityState,
                      text: document.querySelector("section.chat")?.textContent,
                    })),
                    new Promise((resolve) => {
                      setTimeout(() => resolve({ timeout: true }), 5000);
                    }),
                  ]).catch((failure: unknown) => ({ failure: String(failure) })),
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
    }
    await workerNetwork?.close();
    workerNetwork = undefined;
    await browser.close();
    browser = undefined;
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
