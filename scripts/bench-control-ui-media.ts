// Compare already-built production UIs; all Gateway data and media are synthetic.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page } from "playwright";
import { encodePngRgb } from "../src/media/png-encode.js";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionPath,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startBuiltControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../ui/src/test-helpers/control-ui-team-scale-fixture.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-media" },
    pairs: { type: "string", default: "10" },
    profiles: { type: "string", default: "local,remote" },
    trace: { type: "boolean", default: false },
  },
});
const pairs = Number(values.pairs);
const profiles = values.profiles.split(",");
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  profiles.some((name) => !["local", "remote"].includes(name))
) {
  throw new Error("Use positive --pairs and --profiles local,remote");
}
const artifactDir = createControlUiE2eArtifactDir("media", values.output);
const directories = [values["bundle-dir"], values["compare-bundle-dir"]].filter(
  (value): value is string => Boolean(value),
);

function raster(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x + y) % 256;
      pixels[offset + 1] = (y * 3) % 256;
      pixels[offset + 2] = 180;
    }
  }
  return encodePngRgb(pixels, width, height);
}
const photograph = raster(1600, 900);
const icon = raster(40, 40);
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
async function metrics(cdp: CDPSession) {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await cdp.send("Performance.getMetrics");
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
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
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  headless: true,
});
const servers: Array<{
  directory: string;
  build: { buildId: string; version: string };
  sha256: string;
  server: Awaited<ReturnType<typeof startBuiltControlUiE2eServer>>;
}> = [];
type MediaSnapshot = {
  nonce: string;
  cls: number;
  mediaCls: number;
  shifts: Array<{
    value: number;
    sources: Array<{ node: string; media: boolean; previous: number[]; current: number[] }>;
  }>;
  blobs: Array<{ source: string; revoked: boolean; live: boolean; attached: boolean }>;
};
type Metrics = Record<string, number>;
type Result = {
  profile: string;
  pair: number;
  variant: number;
  hostLoad: number[];
  status: "passed" | "failed";
  error?: string;
  errors?: string[];
  loadMs?: number;
  scrollMs?: number;
  stable?: MediaSnapshot;
  scrolled?: MediaSnapshot;
  disposed?: MediaSnapshot;
  requests?: Record<string, number>;
  requestSnapshots?: Record<string, Record<string, number>>;
  steadyRequests?: Record<string, number>;
  bootDuplicates?: Array<[string, number]>;
  duplicates?: Array<[string, number]>;
  before?: Metrics;
  loaded?: Metrics;
  beforeScroll?: Metrics;
  afterScroll?: Metrics;
  beforeDisconnect?: Metrics;
  afterDispose?: Metrics;
  unreferencedFaviconBlobs?: MediaSnapshot["blobs"];
  milliseconds?: Metrics;
  paintDecodeTraceMs?: Metrics;
};
const results: Result[] = [];
try {
  for (const directory of directories) {
    const html = await readFile(path.join(directory, "index.html"), "utf8");
    const raw = html.match(
      /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
    )?.[1];
    if (!raw) {
      throw new Error(`Missing build identity: ${directory}`);
    }
    servers.push({
      directory: path.resolve(directory),
      build: JSON.parse(raw),
      sha256: createHash("sha256").update(html).digest("hex"),
      server: await startBuiltControlUiE2eServer(path.resolve(directory)),
    });
  }
  for (const profile of profiles) {
    for (let pair = 0; pair < pairs; pair++) {
      // Alternate AB/BA order to avoid consistently charging warming/drift to one side.
      for (const variant of pair % 2 ? [...servers.keys()].toReversed() : servers.keys()) {
        const slot = servers[variant]!;
        const prefix = `${profile}-${pair + 1}-${variant}`;
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        const cdp = await context.newCDPSession(page);
        const requests = new Map<string, number>();
        const authContexts = new Map<string, number>();
        let pendingMedia = 0;
        let mediaTransferAt = 0;
        const errors: string[] = [];
        const events: Array<Record<string, unknown>> = [];
        let tracing = false;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") {
            errors.push(message.text());
          }
        });
        page.on("response", (response) => {
          if (response.status() >= 400) {
            errors.push(`HTTP ${response.status()} ${response.url()}`);
          }
        });
        let releaseMedia!: () => void;
        const heldMedia = new Promise<void>((resolve) => {
          releaseMedia = resolve;
        });
        const result: Result = {
          profile,
          pair: pair + 1,
          variant,
          hostLoad: os.loadavg(),
          status: "failed",
        };
        try {
          await page.addInitScript("globalThis.__name = (fn) => fn");
          await page.addInitScript(() => {
            const sources = new WeakMap<Blob, string>();
            const blobs = new Map<string, { source: string; revoked: boolean }>();
            const fetch = window.fetch;
            window.fetch = async (...args) => {
              const response = await fetch(...args);
              const readBlob = response.blob.bind(response);
              response.blob = async () => {
                const blob = await readBlob();
                sources.set(blob, response.url);
                return blob;
              };
              return response;
            };
            const create = URL.createObjectURL.bind(URL);
            const revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = (blob) => {
              const url = create(blob);
              blobs.set(url, {
                source:
                  blob instanceof Blob ? (sources.get(blob) ?? "unclassified") : "MediaSource",
                revoked: false,
              });
              return url;
            };
            URL.revokeObjectURL = (url) => {
              const entry = blobs.get(url);
              if (entry) {
                entry.revoked = true;
              }
              revoke(url);
            };
            let shifts: MediaSnapshot["shifts"] = [];
            const nonce = crypto.randomUUID();
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                const shift = entry as PerformanceEntry & {
                  hadRecentInput: boolean;
                  value: number;
                  sources: Array<{
                    node?: Node;
                    previousRect: DOMRectReadOnly;
                    currentRect: DOMRectReadOnly;
                  }>;
                };
                if (!shift.hadRecentInput) {
                  shifts.push({
                    value: shift.value,
                    sources: shift.sources.map(({ node, previousRect, currentRect }) => ({
                      node:
                        node instanceof Element ? `${node.tagName}.${node.className}` : "detached",
                      media:
                        node instanceof Element &&
                        (node.matches("img,picture,.chat-message-avatar-anchor") ||
                          Boolean(node.querySelector("img,picture"))),
                      previous: [
                        previousRect.x,
                        previousRect.y,
                        previousRect.width,
                        previousRect.height,
                      ],
                      current: [
                        currentRect.x,
                        currentRect.y,
                        currentRect.width,
                        currentRect.height,
                      ],
                    })),
                  });
                }
              }
            });
            observer.observe({ type: "layout-shift", buffered: true });
            Reflect.set(window, "__mediaBench", {
              reset: () => {
                observer.takeRecords();
                shifts = [];
              },
              read: () => ({
                nonce,
                shifts,
                cls: shifts.reduce((sum, item) => sum + item.value, 0),
                mediaCls: shifts
                  .filter((item) => item.sources.some((source) => source.media))
                  .reduce((sum, item) => sum + item.value, 0),
                blobs: [...blobs].map(([url, entry]) =>
                  Object.assign({}, entry, {
                    live: !entry.revoked,
                    attached: [...document.images].some((image) => image.src === url),
                  }),
                ),
              }),
            });
          });
          const fixture = createControlUiTeamScaleFixture({
            now: 1_800_000_000_000,
            sidebarAvatars: true,
            transcriptMessages: 96,
          });
          await page.route("**/*", async (route) => {
            const asset = fixture.assets.get(new URL(route.request().url()).pathname);
            if (!asset) {
              return route.fallback();
            }
            const { delayMs, ...response } = asset;
            if (delayMs) {
              await new Promise((resolve) => {
                setTimeout(resolve, delayMs);
              });
            }
            return route.fulfill(response);
          });
          const messages = Array.from({ length: 96 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            timestamp: 1_800_000_000_000 + index,
            __openclaw: { id: `media-${index}`, seq: index + 1 },
            content: [
              {
                type: "text",
                text: `Media checkpoint ${index}\n\n[Source ${index}](https://media-${index % 8}.example.test/report) and [same source](https://media-${index % 8}.example.test/more).`,
              },
              {
                type: "image",
                url: `media://inbound/media-${index % 16}.png`,
                alt: `Synthetic image ${index}`,
              },
            ],
          }));
          await installMockGateway(page, {
            ...fixture.scenario,
            serverBuildId: slot.build.buildId,
            serverVersion: slot.build.version,
            automaticallyFetchFavicons: true,
            historyMessages: messages,
            sessionTranscripts: { [fixture.selectedSessionKey]: { messages } },
          });
          await page.route(
            /\/(?:__openclaw__\/(?:assistant-media|link-favicon)|api\/users\/[^/]+\/avatar)/u,
            async (route) => {
              const url = new URL(route.request().url());
              const metadata = url.searchParams.get("meta") === "1";
              const kind = url.pathname.includes("assistant-media")
                ? metadata
                  ? "metadata"
                  : "image"
                : url.pathname.includes("avatar")
                  ? "avatar"
                  : "favicon";
              // Keep revision/ticket/size queries and auth scopes distinct, without recording credentials.
              const headers = route.request().headers();
              const contextKey = `${headers.authorization ?? ""}\n${headers.cookie ?? ""}`;
              if (!authContexts.has(contextKey)) {
                authContexts.set(contextKey, authContexts.size + 1);
              }
              const resource = `${kind}:${route.request().method()}:context-${authContexts.get(contextKey)}:${url.href}`;
              requests.set(resource, (requests.get(resource) ?? 0) + 1);
              pendingMedia += 1;
              try {
                await heldMedia;
                const body = kind === "image" ? photograph : icon;
                if (profile === "remote") {
                  // Routed responses share a 10 Mbps budget after one request RTT.
                  mediaTransferAt =
                    Math.max(Date.now() + 100, mediaTransferAt) +
                    (metadata ? 200 : body.length) / 1250;
                  await new Promise((resolve) => {
                    setTimeout(resolve, mediaTransferAt - Date.now());
                  });
                }
                await route.fulfill(
                  metadata
                    ? {
                        json: {
                          available: true,
                          mediaTicket: "synthetic-media-ticket",
                          mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
                        },
                      }
                    : {
                        contentType: "image/png",
                        body,
                        headers: { "Cache-Control": "public, max-age=3600" },
                      },
                );
              } finally {
                pendingMedia -= 1;
              }
            },
          );
          await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
          await cdp.send("Network.enable");
          if (profile === "remote") {
            await cdp.send("Network.emulateNetworkConditions", {
              offline: false,
              latency: 100,
              downloadThroughput: 1_250_000,
              uploadThroughput: 1_250_000,
            });
          }
          await page.goto(
            new URL(controlUiSessionPath(fixture.selectedSessionKey), slot.server.baseUrl).href,
          );
          await page.locator(".chat-thread").waitFor();
          await page.getByText("Media checkpoint 95", { exact: false }).first().waitFor();
          await page.locator('[data-navigation-view="online"]').click();
          await page.locator("[data-online-user-id]").first().waitFor();
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await frames(page);
          // CLS excludes shifts within 500 ms of input; finish the roster click's window.
          await page.waitForTimeout(550);
          if (pair === 0) {
            await page.screenshot({ path: path.join(artifactDir, `${prefix}-pending.png`) });
          }
          await cdp.send("HeapProfiler.collectGarbage");
          const before = await metrics(cdp);
          if (values.trace) {
            cdp.on("Tracing.dataCollected", ({ value }) => {
              events.push(...value);
            });
            await cdp.send("Tracing.start", {
              categories: "toplevel,devtools.timeline,disabled-by-default-devtools.timeline",
              transferMode: "ReportEvents",
            });
            tracing = true;
          }
          await page.evaluate(() => Reflect.get(window, "__mediaBench").reset());
          const nonce = await page.evaluate(() => Reflect.get(window, "__mediaBench").read().nonce);
          const bootRequests = Object.fromEntries(requests);
          result.before = before;
          result.requestSnapshots = { before: bootRequests };
          const started = performance.now();
          releaseMedia();
          const settleMedia = async () => {
            const deadline = Date.now() + 30_000;
            let settledFrames = 0;
            while (settledFrames < 2) {
              // Allow intersection admission and fetch-to-img handoff before testing quiescence.
              await frames(page);
              const loading =
                pendingMedia > 0 ||
                (await page.evaluate(() =>
                  [...document.images].some((image) => {
                    // Unadmitted off-screen placeholders have neither src nor loading state.
                    if (
                      image.dataset.linkFaviconState !== "loading" &&
                      (!image.src || image.complete)
                    ) {
                      return false;
                    }
                    const rect = image.getBoundingClientRect();
                    if (
                      image.closest("[inert]") ||
                      rect.bottom <= 0 ||
                      rect.top >= innerHeight ||
                      rect.right <= 0 ||
                      rect.left >= innerWidth
                    ) {
                      return false;
                    }
                    let top = rect.top;
                    let bottom = rect.bottom;
                    let left = rect.left;
                    let right = rect.right;
                    for (let parent = image.parentElement; parent; parent = parent.parentElement) {
                      const style = getComputedStyle(parent);
                      const bounds = parent.getBoundingClientRect();
                      if (style.overflowY !== "visible") {
                        top = Math.max(top, bounds.top + parent.clientTop);
                        bottom = Math.min(
                          bottom,
                          bounds.top + parent.clientTop + parent.clientHeight,
                        );
                      }
                      if (style.overflowX !== "visible") {
                        left = Math.max(left, bounds.left + parent.clientLeft);
                        right = Math.min(
                          right,
                          bounds.left + parent.clientLeft + parent.clientWidth,
                        );
                      }
                      if (bottom <= top || right <= left) {
                        return false;
                      }
                    }
                    return true;
                  }),
                ));
              settledFrames = pendingMedia === 0 && !loading ? settledFrames + 1 : 0;
              if (Date.now() > deadline) {
                throw new Error(
                  `Media did not settle: ${pendingMedia} admitted HTTP requests pending`,
                );
              }
              if (!settledFrames) {
                await new Promise((resolve) => {
                  setTimeout(resolve, 25);
                });
              }
            }
          };
          await page.waitForFunction(
            () =>
              [...document.querySelectorAll<HTMLImageElement>(".chat-message-image")].some(
                (image) => image.naturalWidth > 0,
              ) &&
              [...document.querySelectorAll<HTMLImageElement>(".markdown-link-favicon")].some(
                (image) => image.naturalWidth > 0,
              ),
          );
          await settleMedia();
          const stable = await page.evaluate<MediaSnapshot>(() =>
            Reflect.get(window, "__mediaBench").read(),
          );
          const stableRequests = Object.fromEntries(requests);
          result.stable = stable;
          result.requestSnapshots.stable = stableRequests;
          const loadMs = performance.now() - started;
          result.loadMs = loadMs;
          const loaded = await metrics(cdp);
          if (pair === 0) {
            await page.screenshot({ path: path.join(artifactDir, `${prefix}-loaded.png`) });
          }
          const beforeScroll = await metrics(cdp);
          const scrollStarted = performance.now();
          // Descend through the transcript, then remount the starting images.
          for (const fraction of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 0, 1]) {
            await page.locator(".chat-thread").evaluate((element, amount) => {
              element.scrollTop = (element.scrollHeight - element.clientHeight) * amount;
              element.dispatchEvent(new Event("scroll", { bubbles: true }));
            }, fraction);
            await page.locator(".sidebar-shell__body").evaluate((element, amount) => {
              element.scrollTop = (element.scrollHeight - element.clientHeight) * amount;
            }, fraction);
            await settleMedia();
          }
          const scrollMs = performance.now() - scrollStarted;
          const afterScroll = await metrics(cdp);
          const scrolled = await page.evaluate<MediaSnapshot>(() =>
            Reflect.get(window, "__mediaBench").read(),
          );
          const scrollRequests = Object.fromEntries(requests);
          result.scrolled = scrolled;
          result.scrollMs = scrollMs;
          result.requestSnapshots.scroll = scrollRequests;
          if (tracing) {
            const complete = new Promise<void>((resolve) => {
              cdp.once("Tracing.tracingComplete", () => resolve());
            });
            await cdp.send("Tracing.end");
            await complete;
            tracing = false;
            await writeFile(
              path.join(artifactDir, `${prefix}.trace.json`),
              JSON.stringify({ traceEvents: events }),
            );
            result.paintDecodeTraceMs = Object.fromEntries(
              ["Paint", "PaintImage", "Decode Image", "ImageDecodeTask", "RasterTask"].map(
                (name) => [
                  name,
                  events
                    .filter((entry) => entry.name === name)
                    .reduce(
                      (sum, entry) => sum + (typeof entry.dur === "number" ? entry.dur : 0),
                      0,
                    ) / 1000,
                ],
              ),
            );
          }
          // Retire the native app host, preserving the document for lifetime measurement.
          // Settings intentionally parks the transcript and cannot prove disposal.
          await cdp.send("HeapProfiler.collectGarbage");
          const beforeDisconnect = await metrics(cdp);
          await page.locator("openclaw-app").evaluate((element) => element.remove());
          await page.locator(".chat-thread").waitFor({ state: "detached" });
          await frames(page);
          await cdp.send("HeapProfiler.collectGarbage");
          const disposed = await page.evaluate<MediaSnapshot>(() =>
            Reflect.get(window, "__mediaBench").read(),
          );
          result.disposed = disposed;
          if ([stable, scrolled, disposed].some((snapshot) => snapshot.nonce !== nonce)) {
            throw new Error("Document reloaded; object URL disposal evidence is invalid");
          }
          const disposedRequests = Object.fromEntries(requests);
          const steadyRequests = Object.fromEntries(
            [...requests]
              .map(([key, count]): [string, number] => [key, count - (bootRequests[key] ?? 0)])
              .filter(([, count]) => count > 0),
          );
          const afterDispose = await metrics(cdp);
          Object.assign(result, {
            status: errors.length ? "failed" : "passed",
            errors,
            loadMs,
            scrollMs,
            stable,
            scrolled,
            disposed,
            requests: Object.fromEntries(requests),
            requestSnapshots: {
              before: bootRequests,
              stable: stableRequests,
              scroll: scrollRequests,
              dispose: disposedRequests,
            },
            steadyRequests,
            bootDuplicates: Object.entries(bootRequests).filter(([, count]) => count > 1),
            duplicates: Object.entries(steadyRequests).filter(([, count]) => count > 1),
            before,
            loaded,
            beforeScroll,
            afterScroll,
            beforeDisconnect,
            afterDispose,
            unreferencedFaviconBlobs: disposed.blobs.filter(
              (blob) =>
                blob.live && !blob.attached && blob.source.includes("/__openclaw__/link-favicon/"),
            ),
            milliseconds: Object.fromEntries(
              ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
                (name) => [
                  name,
                  1000 * (loaded[name]! - before[name]! + afterScroll[name]! - beforeScroll[name]!),
                ],
              ),
            ),
          });
        } catch (error) {
          result.error = `${String(error)} (page: ${page.url()})`;
          result.errors = errors;
          await page
            .screenshot({ path: path.join(artifactDir, `${prefix}-failed.png`) })
            .catch(() => undefined);
        } finally {
          releaseMedia();
          if (tracing) {
            await cdp.send("Tracing.end").catch(() => undefined);
          }
          results.push(result);
          await writeFile(
            path.join(artifactDir, `${prefix}.json`),
            JSON.stringify(result, null, 2),
          );
          await cdp.detach();
          await context.close();
        }
        console.log(
          JSON.stringify({
            profile,
            pair: pair + 1,
            variant,
            status: result.status,
            loadMs: result.loadMs,
            scrollMs: result.scrollMs,
          }),
        );
      }
    }
  }
} finally {
  await browser.close();
  await Promise.all(servers.map(({ server }) => server.close()));
  const timing = profiles.flatMap((profile) =>
    servers.map((_, variant) => {
      const samples = results.filter(
        (row) => row.profile === profile && row.variant === variant && row.status === "passed",
      );
      return {
        profile,
        variant,
        samples: samples.length,
        ...Object.fromEntries(
          (["loadMs", "scrollMs"] as const).map((key) => [
            key,
            samples.length ? distribution(samples.map((row) => Number(row[key]))) : null,
          ]),
        ),
      };
    }),
  );
  await writeFile(
    path.join(artifactDir, "summary.json"),
    JSON.stringify(
      {
        browser: browser.version(),
        durationClock: "threadTicks",
        bundles: servers.map(({ server: _server, ...item }) => item),
        fixture: {
          messages: 96,
          uniqueImages: 16,
          imageSize: [1600, 900],
          uniqueHosts: 8,
          avatars: 120,
        },
        timing,
        results,
        acceptance:
          "Zero stable-viewport media CLS; <=1 request per unique media resource and kind; inspect live blobs after native app-host disconnection without document reload. >=10 AB/BA pairs: median <=5% regression and p95 not worse; noisy hosts require a separate A/A control and 20 pairs judged by CDP CPU plus structural counters.",
        limitations:
          "Synthetic Gateway RPC has no RTT. Static HTTP uses CDP 100ms/10Mbps throttling; routed media uses equivalent explicit delay because Playwright fulfillment bypasses network emulation. Playwright routing disables HTTP cache; duplicate fetch counters test application ownership. CDP durations include media load and scroll, not navigation or disposal; heap metrics are JS heap only, not native decoded-image memory. No total decoded-memory claim.",
      },
      null,
      2,
    ),
  );
}
if (results.some((row) => row.status !== "passed")) {
  process.exitCode = 1;
}
