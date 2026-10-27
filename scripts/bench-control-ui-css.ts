// Direct cold route loads through production HTTP with synthetic Gateway data.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type CDPSession } from "playwright";
import { buildSandboxHostPath } from "../src/agents/sandbox-host.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../src/gateway/control-ui-bootstrap-contract.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSandboxFixtureServer } from "../ui/src/test-helpers/control-ui-sandbox-fixture-server.ts";
import { createControlUiTeamScaleFixture } from "../ui/src/test-helpers/control-ui-team-scale-fixture.ts";
import { TEAM_SCALE_COUNTS } from "../ui/src/test-helpers/control-ui-team-scale-inventory.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string" },
    "compare-bundle-dir": { type: "string" },
    pairs: { type: "string", default: "10" },
    routes: { type: "string", default: "chat,new,sessions,settings" },
    viewports: { type: "string", default: "desktop,mobile" },
    themes: { type: "string", default: "light,dark" },
    "cpu-rates": { type: "string", default: "1,4" },
    "network-latency-ms": { type: "string", default: "0" },
    coverage: { type: "boolean", default: false },
    output: { type: "string", default: ".artifacts/control-ui-css" },
  },
});
if (!values["bundle-dir"]) {
  throw new Error("--bundle-dir is required (an already-built bundle)");
}
function selection<T extends string>(value: string, allowed: readonly T[]): T[] {
  return [
    ...new Set(
      value.split(",").map((item) => {
        const selected = allowed.find((candidate) => candidate === item);
        if (!selected) {
          throw new Error(`Expected comma-separated values from ${allowed.join(",")}: ${value}`);
        }
        return selected;
      }),
    ),
  ];
}
const routes = selection(values.routes, ["chat", "new", "sessions", "settings"]);
const viewports = selection(values.viewports, ["desktop", "mobile"]);
const themes = selection(values.themes, ["light", "dark"]);
const cpuRates = values["cpu-rates"].split(",").map(Number);
const pairs = Number(values.pairs);
const latencyMs = Number(values["network-latency-ms"]);
if (
  !Number.isSafeInteger(pairs) ||
  pairs < 1 ||
  cpuRates.some((rate) => !Number.isFinite(rate) || rate < 1) ||
  !Number.isFinite(latencyMs) ||
  latencyMs < 0
) {
  throw new Error("Use positive integer pairs, CPU rates >= 1, and nonnegative network latency");
}
const output = createControlUiE2eArtifactDir("css", path.resolve(values.output));
const base = path.resolve(values["bundle-dir"]);
const head = values["compare-bundle-dir"] ? path.resolve(values["compare-bundle-dir"]) : undefined;
async function buildInfo(directory: string) {
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const raw = html.match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)?.[1];
  if (!raw) {
    throw new Error(`Missing build identity in ${directory}`);
  }
  const info: { buildId: string; version: string } = JSON.parse(raw);
  return { ...info, indexSha256: createHash("sha256").update(html).digest("hex") };
}
const variants = [
  { name: "base", directory: base, build: await buildInfo(base) },
  ...(head && !values.coverage
    ? [{ name: "control", directory: base, build: await buildInfo(base) }]
    : []),
  ...(head ? [{ name: "head", directory: head, build: await buildInfo(head) }] : []),
];
const server = await startControlUiBenchGatewayServer(base);
const sandbox = createControlUiSandboxFixtureServer((pathname) => fixture.assets.get(pathname));
await new Promise<void>((resolve, reject) => {
  sandbox.once("error", reject);
  sandbox.listen(0, "127.0.0.1", resolve);
});
const address = sandbox.address();
if (!address || typeof address === "string") {
  throw new Error("Sandbox did not bind");
}
const fixture = createControlUiTeamScaleFixture({
  now: 1_800_000_000_000,
  baseUrl: server.baseUrl,
  sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
  sandboxPort: address.port,
});
server.setFixtureReader((pathname) => fixture.assets.get(pathname));
const cells = routes.flatMap((route) =>
  viewports.flatMap((viewport) =>
    themes.flatMap((theme) => cpuRates.map((cpuRate) => ({ route, viewport, theme, cpuRate }))),
  ),
);
const metricNames = [
  "TaskDuration",
  "ScriptDuration",
  "LayoutDuration",
  "RecalcStyleDuration",
  "LayoutCount",
  "RecalcStyleCount",
] as const;
async function metrics(cdp: CDPSession) {
  const response: { metrics: Array<{ name: string; value: number }> } =
    await cdp.send("Performance.getMetrics");
  return Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]));
}
function distribution(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}
type Sample = {
  pair: number;
  variant: string;
  cell: (typeof cells)[number];
  hostLoad: number[];
  shellReadyMs: number;
  readyMs: number;
  metrics: Record<string, number>;
  cssRequests: number;
  requestedStylesheets: string[];
  resources: unknown;
  coverage?: unknown;
};
const results: Sample[] = [];
async function save() {
  const summaries = cells.map((cell) => ({
    cell,
    variants: Object.fromEntries(
      variants.map(({ name }) => {
        const samples = results.filter((sample) => sample.cell === cell && sample.variant === name);
        return [
          name,
          samples.length
            ? {
                samples: samples.length,
                readyMs: distribution(samples.map((sample) => sample.readyMs)),
                ...Object.fromEntries(
                  metricNames.map((metric) => [
                    metric,
                    distribution(samples.map((sample) => sample.metrics[metric]!)),
                  ]),
                ),
              }
            : null,
        ];
      }),
    ),
  }));
  await writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(
      {
        workload: "cold direct routes, synthetic team-scale Gateway, production HTTP",
        mode: values.coverage ? "coverage (instrumented; exclude from timing claims)" : "timing",
        metricClock: "threadTicks; duration metrics in ms, counts unscaled",
        pairs,
        latencyMs,
        variants,
        browser: browser?.version(),
        results,
        summaries,
      },
      null,
      2,
    ),
  );
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  // Prepare both immutable asset roots before timing; HTTP client caches stay cold.
  if (head) {
    await server.selectBuild(head);
  }
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    args: ["--disable-partial-raster", "--disable-gpu-rasterization"],
  });
  for (let pair = 0; pair < pairs; pair++) {
    for (const cell of cells) {
      // Reverse complete triplets to expose drift; the control always repeats base.
      for (const variant of pair % 2 ? variants.toReversed() : variants) {
        await server.selectBuild(variant.directory);
        const id = `${cell.route}-${cell.viewport}-${cell.theme}-${cell.cpuRate}x-${pair + 1}-${variant.name}`;
        const context = await browser.newContext({
          viewport:
            cell.viewport === "desktop"
              ? { width: 1440, height: 1000 }
              : { width: 390, height: 844 },
          colorScheme: cell.theme,
          locale: "en-US",
          timezoneId: "UTC",
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        await page.addInitScript("globalThis.__name = (fn) => fn");
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const scenario = {
            ...fixture.scenario,
            serverBuildId: variant.build.buildId,
            serverVersion: variant.build.version,
          };
          await installMockGateway(page, scenario);
          const init = ({
            bootstrap,
            attribute,
            storageKey,
            theme,
            pins,
            route,
          }: {
            bootstrap: string;
            attribute: string;
            storageKey: string;
            theme: string;
            pins: string[];
            route: string;
          }) => {
            if (window !== window.top || location.protocol === "about:") {
              return;
            }
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                theme: "claw",
                themeMode: theme,
                sidebarAgentsMode: "chip",
                railShortcuts: pins,
                navigationByProfile: { "team-person-001": { railShortcuts: pins } },
              }),
            );
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
            let previousReady = false;
            const check = () => {
              const snapshot = window.openclawControlUi?.snapshot();
              const expectedRoute =
                route === "new" ? "new-session" : route === "settings" ? "appearance" : route;
              const selector =
                route === "new"
                  ? ".new-session-page__message"
                  : route === "sessions"
                    ? ".sessions-table tbody tr"
                    : route === "settings"
                      ? ".settings-theme-grid [data-theme-id]"
                      : ".agent-chat__composer-combobox textarea";
              const node = document.querySelector<HTMLInputElement>(selector);
              const frame = document.querySelector("section.chat");
              const ready =
                snapshot?.routeReady &&
                snapshot.route?.status === "success" &&
                snapshot.route.matches[0]?.routeId === expectedRoute &&
                snapshot.route.pendingMatches.length === 0 &&
                document.documentElement.dataset.themeMode === theme &&
                node &&
                !node.disabled &&
                node.getClientRects().length > 0 &&
                (route !== "chat" ||
                  (frame &&
                    frame.getBoundingClientRect().height > 0 &&
                    Boolean(document.querySelector("section.chat .chat-text"))));
              if (ready && previousReady) {
                Reflect.set(window, "__cssShellReadyMs", performance.now());
                return;
              }
              previousReady = Boolean(ready);
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          };
          await page.addInitScript({
            content: `;(() => { const __name = (fn) => fn; (${init.toString()})(${JSON.stringify({
              bootstrap: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
              attribute: CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
              storageKey: controlUiBundledSettingsStorageKey(server.baseUrl),
              theme: cell.theme,
              pins: fixture.sidebarEntries,
              route: cell.route,
            })}); })();`,
          });
          const cdp = await context.newCDPSession(page);
          const requestedStylesheets: string[] = [];
          cdp.on("Network.requestWillBeSent", ({ type, request }) => {
            if (type === "Stylesheet") {
              requestedStylesheets.push(request.url);
            }
          });
          await cdp.send("Network.enable");
          await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: latencyMs,
            downloadThroughput: latencyMs ? 1_250_000 : -1,
            uploadThroughput: -1,
          });
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: cell.cpuRate });
          await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
          if (values.coverage) {
            await page.coverage.startCSSCoverage({ resetOnNavigation: false });
          }
          const before = await metrics(cdp);
          const hostLoad = loadavg();
          const url =
            cell.route === "chat"
              ? controlUiSessionUrl(server.baseUrl, fixture.selectedSessionKey)
              : new URL(
                  cell.route === "new"
                    ? "/new"
                    : cell.route === "settings"
                      ? "/settings/appearance"
                      : "/sessions",
                  server.baseUrl,
                ).href;
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.waitForFunction(
            () => Reflect.get(window, "__cssShellReadyMs") > 0,
            undefined,
            {
              timeout: 60_000,
            },
          );
          if (cell.route === "chat") {
            const title = `Team metric ${TEAM_SCALE_COUNTS.inlineWidgets}`;
            const selector = `iframe.chat-tool-card__preview-frame[title="${title}"]`;
            const widget = page.frameLocator(selector).frameLocator("iframe");
            const heading = widget.getByRole("heading", { name: title, exact: true });
            await heading.waitFor({ state: "visible" });
            await widget.locator("body").evaluate(async (body) => {
              await body.ownerDocument.fonts.ready;
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              });
            });
            const bounds = await heading.boundingBox();
            const viewport = page.viewportSize();
            if (
              !bounds ||
              !viewport ||
              bounds.x + bounds.width <= 0 ||
              bounds.y + bounds.height <= 0 ||
              bounds.x >= viewport.width ||
              bounds.y >= viewport.height
            ) {
              throw new Error(
                "Chat's synthetic metric must be visible before stopping boot metrics",
              );
            }
          }
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });
            Reflect.set(window, "__cssBootReadyMs", performance.now());
          });
          const after = await metrics(cdp);
          const measuredStylesheets = requestedStylesheets.slice();
          const css = values.coverage ? await page.coverage.stopCSSCoverage() : undefined;
          const data = await page.evaluate(() => ({
            shellReadyMs: Number(Reflect.get(window, "__cssShellReadyMs")),
            readyMs: Number(Reflect.get(window, "__cssBootReadyMs")),
            resources: performance
              .getEntriesByType("resource")
              .filter((entry) => new URL(entry.name).pathname.endsWith(".css"))
              .map((entry) => {
                // SAFETY: getEntriesByType("resource") returns resource timing entries.
                const resource = entry as PerformanceResourceTiming;
                return {
                  url: resource.name,
                  initiator: resource.initiatorType,
                  startTime: resource.startTime,
                  responseEnd: resource.responseEnd,
                  decodedBodySize: resource.decodedBodySize,
                  encodedBodySize: resource.encodedBodySize,
                };
              }),
          }));
          const sample: Sample = {
            pair: pair + 1,
            variant: variant.name,
            cell,
            hostLoad,
            ...data,
            cssRequests: measuredStylesheets.length,
            requestedStylesheets: measuredStylesheets,
            metrics: Object.fromEntries(
              metricNames.map((name) => [
                name,
                (after[name]! - before[name]!) * (name.endsWith("Duration") ? 1000 : 1),
              ]),
            ),
          };
          if (css) {
            // Coverage is observed rule use, not dead-CSS or selector deletion authority.
            // Chromium reports ranges for a rule when any selector matches during boot.
            const filename = `${id}.coverage.json`;
            await writeFile(path.join(output, filename), JSON.stringify(css));
            sample.coverage = {
              file: filename,
              stylesheets: css.map((sheet) => {
                if (sheet.text === undefined) {
                  throw new Error(`Missing CSS source text: ${sheet.url}`);
                }
                const text = sheet.text;
                return {
                  url: sheet.url,
                  sha256: createHash("sha256").update(text).digest("hex"),
                  bytes: Buffer.byteLength(text),
                  usedBytes: sheet.ranges.reduce(
                    (sum, range) => sum + Buffer.byteLength(text.slice(range.start, range.end)),
                    0,
                  ),
                  ranges: sheet.ranges.length,
                };
              }),
            };
          }
          if (errors.length) {
            throw new Error(errors.join("\n"));
          }
          results.push(sample);
          console.log(
            JSON.stringify({
              id,
              readyMs: sample.readyMs,
              metrics: sample.metrics,
              cssRequests: sample.cssRequests,
              hostLoad,
            }),
          );
          // Capture after the measured interval; screenshot font/animation settling is not timed.
          if (pair === 0 && cell.cpuRate === cpuRates[0]) {
            await page.locator("openclaw-app").screenshot({
              path: path.join(output, `${id}.png`),
              animations: "disabled",
            });
          }
        } catch (error) {
          await writeFile(
            path.join(output, `${id}.failure.json`),
            JSON.stringify({ error: String(error), errors }, null, 2),
          );
          await page
            .screenshot({ path: path.join(output, `${id}.failure.png`) })
            .catch(() => undefined);
          throw error;
        } finally {
          await context.close();
        }
      }
    }
    await save();
  }
} finally {
  try {
    await save();
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await new Promise<void>((resolve, reject) => {
          sandbox.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        await server.close();
      }
    }
  }
}
