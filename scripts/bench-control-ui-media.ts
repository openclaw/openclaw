// Compare already-built production UIs; all Gateway data and media are synthetic.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, webkit, type CDPSession, type Page, type Request } from "playwright";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import { encodeImageThumbnail } from "../src/gateway/managed-image-thumbnail-cache.js";
import { encodePngRgb } from "../src/media/png-encode.js";
import { normalizeChatImageRenditionWidth } from "../src/shared/chat-image-renditions.js";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionPath,
  createControlUiMockBootstrapConfig,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../ui/src/test-helpers/control-ui-team-scale-fixture.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import {
  classifyMediaErrors,
  type MediaConsoleError,
  type MediaFailedRequest,
  type MediaFetchAttempt,
} from "./lib/control-ui-media-errors.ts";
import {
  installControlUiMediaObserver,
  type GeometryReport,
  type MediaSnapshot,
} from "./lib/control-ui-media-observer.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-media" },
    pairs: { type: "string", default: "10" },
    profiles: { type: "string", default: "local,remote" },
    trace: { type: "boolean", default: false },
    engine: { type: "string", default: "chromium" },
    geometry: { type: "boolean", default: false },
    dimensions: { type: "string", default: "missing" },
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
if (values.engine !== "chromium" && values.engine !== "webkit") {
  throw new Error("Use --engine chromium|webkit");
}
if (values.trace && values.engine !== "chromium") {
  throw new Error("--trace uses Chromium CDP; WebKit reports wall timings without CPU metrics");
}
if (values.dimensions !== "missing" && values.dimensions !== "canonical") {
  throw new Error("Use --dimensions missing|canonical");
}
const engine = values.engine;
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
const thumbnails = new Map(
  await Promise.all(
    ([480, 960, 1920] as const).map(
      async (width) => [width, await encodeImageThumbnail(photograph, width)] as const,
    ),
  ),
);
function mediaKind(url: URL) {
  if (url.pathname.includes("/__openclaw__/assistant-media")) {
    return url.searchParams.get("meta") === "1" ? "metadata" : "image";
  }
  if (/\/api\/users\/[^/]+\/avatar/u.test(url.pathname)) {
    return "avatar";
  }
  return url.pathname.includes("/__openclaw__/link-favicon") ? "favicon" : undefined;
}
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
async function metrics(cdp: CDPSession | undefined) {
  if (!cdp) {
    return undefined;
  }
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
const browser =
  engine === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({
        executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
        headless: true,
      });
const servers: Array<{
  directory: string;
  build: { buildId: string; version: string };
  sha256: string;
  server: Awaited<ReturnType<typeof startControlUiBenchGatewayServer>>;
}> = [];
type Metrics = Record<string, number>;
type Result = {
  engine: string;
  geometry?: GeometryReport;
  profile: string;
  pair: number;
  variant: number;
  hostLoad: number[];
  status: "passed" | "failed";
  error?: string;
  errors?: string[];
  pageErrors?: string[];
  httpErrors?: string[];
  consoleErrors?: MediaConsoleError[];
  failedRequests?: MediaFailedRequest[];
  expectedCacheMisses?: MediaConsoleError[];
  unexpectedErrors?: string[];
  loadMs?: number;
  scrollMs?: number;
  stable?: MediaSnapshot;
  scrolled?: MediaSnapshot;
  disposed?: MediaSnapshot;
  layoutShiftPhaseSums?: {
    load: number | null;
    scroll: number | null;
    disposal: number | null;
  };
  requests?: Record<string, number>;
  requestSnapshots?: Record<string, Record<string, number>>;
  steadyRequests?: Record<string, number>;
  bootDuplicates?: Array<[string, number]>;
  duplicates?: Array<[string, number]>;
  cacheProbe?: {
    transport: "native-http";
    browserHttpCache: "enabled";
    serverRequests: Array<{ method: string; url: string }>;
    fetchAttempts: {
      cacheOnly: MediaFetchAttempt[];
      networkEligible: MediaFetchAttempt[];
    } | null;
    networkDownloads: null;
  };
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
      server: await startControlUiBenchGatewayServer(path.resolve(directory)),
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
        const cdp = engine === "chromium" ? await context.newCDPSession(page) : undefined;
        const requests = new Map<string, number>();
        const authContexts = new Map<string, number>();
        const pendingMedia = new Set<Request>();
        const serverRequestOffset = slot.server.requests.length;
        let mediaTransferAt = 0;
        const errors: string[] = [];
        const pageErrors: string[] = [];
        const httpErrors: string[] = [];
        const consoleErrors: NonNullable<Result["consoleErrors"]> = [];
        const failedRequests: NonNullable<Result["failedRequests"]> = [];
        const events: Array<Record<string, unknown>> = [];
        let tracing = false;
        page.on("pageerror", (error) => {
          errors.push(error.message);
          pageErrors.push(error.message);
        });
        page.on("request", (request) => {
          const url = new URL(request.url());
          const kind = mediaKind(url);
          if (!kind) {
            return;
          }
          const headers = request.headers();
          const contextKey = `${headers.authorization ?? ""}\n${headers.cookie ?? ""}`;
          if (!authContexts.has(contextKey)) {
            authContexts.set(contextKey, authContexts.size + 1);
          }
          const resource = `${kind}:${request.method()}:context-${authContexts.get(contextKey)}:${url.href}`;
          requests.set(resource, (requests.get(resource) ?? 0) + 1);
          pendingMedia.add(request);
        });
        page.on("requestfinished", (request) => pendingMedia.delete(request));
        page.on("requestfailed", (request) => {
          pendingMedia.delete(request);
          failedRequests.push({
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            errorText: request.failure()?.errorText ?? "",
          });
        });
        page.on("console", (message) => {
          if (message.type() === "error") {
            errors.push(message.text());
            consoleErrors.push({
              type: message.type(),
              message: message.text(),
              ...message.location(),
            });
          }
        });
        page.on("response", (response) => {
          if (response.status() >= 400) {
            const error = `HTTP ${response.status()} ${response.url()}`;
            errors.push(error);
            httpErrors.push(error);
          }
        });
        let releaseMedia!: () => void;
        const heldMedia = new Promise<void>((resolve) => {
          releaseMedia = resolve;
        });
        const result: Result = {
          engine,
          profile,
          pair: pair + 1,
          variant,
          hostLoad: os.loadavg(),
          status: "failed",
        };
        try {
          await page.addInitScript("globalThis.__name = (fn) => fn");
          await page.addInitScript(installControlUiMediaObserver);
          const fixture = createControlUiTeamScaleFixture({
            now: 1_800_000_000_000,
            sidebarAvatars: true,
            transcriptMessages: 96,
          });
          const messages = Array.from({ length: 96 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            timestamp: 1_800_000_000_000 + index,
            __openclaw: {
              id: `media-${index}`,
              seq: index + 1,
              ...(values.dimensions === "canonical"
                ? {
                    media: [
                      {
                        path: `media://inbound/media-${index % 16}.png`,
                        contentType: "image/png",
                        width: 1600,
                        height: 900,
                      },
                    ],
                    mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
                  }
                : {}),
            },
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
          // Let the mock's transcript owner serve this benchmark's media messages.
          const methodResponses = { ...fixture.scenario.methodResponses };
          delete methodResponses["chat.startup"];
          delete methodResponses["chat.history"];
          const scenario = {
            ...fixture.scenario,
            methodResponses,
            serverBuildId: slot.build.buildId,
            serverVersion: slot.build.version,
            automaticallyFetchFavicons: true,
            historyMessages: messages,
            sessionTranscripts: { [fixture.selectedSessionKey]: { messages } },
          };
          slot.server.setFixtureReader(async (pathname, url) => {
            if (pathname === CONTROL_UI_BOOTSTRAP_CONFIG_PATH) {
              return {
                body: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
                contentType: "application/json",
              };
            }
            const kind = mediaKind(url);
            if (!kind) {
              return fixture.assets.get(pathname);
            }
            await heldMedia;
            const metadata = kind === "metadata";
            const thumbnail = kind === "image" && url.searchParams.get("variant") === "thumbnail";
            const body = metadata
              ? JSON.stringify({
                  available: true,
                  mediaTicket: "synthetic-media-ticket",
                  mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
                })
              : thumbnail
                ? thumbnails.get(normalizeChatImageRenditionWidth(url.searchParams.get("width")))!
                : kind === "image"
                  ? photograph
                  : icon;
            if (profile === "remote") {
              // Only real HTTP requests share this 10 Mbps budget after one RTT.
              mediaTransferAt =
                Math.max(Date.now() + 100, mediaTransferAt) + Buffer.byteLength(body) / 1250;
              await new Promise((resolve) => {
                setTimeout(resolve, mediaTransferAt - Date.now());
              });
            }
            return {
              body,
              contentType: metadata ? "application/json" : thumbnail ? "image/webp" : "image/png",
              headers: {
                "Cache-Control": metadata
                  ? "private, no-store"
                  : kind === "image"
                    ? "private, no-cache"
                    : "private, max-age=3600",
                Vary: "Authorization, Cookie",
              },
            };
          });
          await installMockGateway(page, scenario);
          // The server owns bootstrap and media; interception would disable HTTP cache.
          await page.unrouteAll();
          await cdp?.send("Performance.enable", { timeDomain: "threadTicks" });
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
          await cdp?.send("HeapProfiler.collectGarbage");
          const before = await metrics(cdp);
          if (values.trace && cdp) {
            cdp.on("Tracing.dataCollected", ({ value }) => {
              events.push(...value);
            });
            await cdp.send("Tracing.start", {
              categories: "toplevel,devtools.timeline,disabled-by-default-devtools.timeline",
              transferMode: "ReportEvents",
            });
            tracing = true;
          }
          await page.evaluate(() => window.controlUiMediaBench.reset());
          const nonce = await page.evaluate(() => window.controlUiMediaBench.read().nonce);
          const bootRequests = Object.fromEntries(requests);
          result.before = before;
          result.requestSnapshots = { before: bootRequests };
          if (values.geometry) {
            await page.evaluate(() => window.controlUiMediaBench.startGeometry());
          }
          const started = performance.now();
          releaseMedia();
          const settleMedia = async () => {
            const deadline = Date.now() + 30_000;
            let settledFrames = 0;
            while (settledFrames < 2) {
              // Allow intersection admission and fetch-to-img handoff before testing quiescence.
              await frames(page);
              const loading =
                pendingMedia.size > 0 ||
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
              settledFrames = pendingMedia.size === 0 && !loading ? settledFrames + 1 : 0;
              if (Date.now() > deadline) {
                throw new Error(
                  `Media did not settle: ${pendingMedia.size} browser requests pending`,
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
          if (values.geometry) {
            result.geometry = await page.evaluate<GeometryReport>(() =>
              window.controlUiMediaBench.stopGeometry(),
            );
          }
          const stable = await page.evaluate<MediaSnapshot>(() =>
            window.controlUiMediaBench.read(),
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
            window.controlUiMediaBench.read(),
          );
          const scrollRequests = Object.fromEntries(requests);
          result.scrolled = scrolled;
          result.scrollMs = scrollMs;
          result.requestSnapshots.scroll = scrollRequests;
          if (tracing && cdp) {
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
          await cdp?.send("HeapProfiler.collectGarbage");
          const beforeDisconnect = await metrics(cdp);
          await page.locator("openclaw-app").evaluate((element) => element.remove());
          await page.locator(".chat-thread").waitFor({ state: "detached" });
          await frames(page);
          await cdp?.send("HeapProfiler.collectGarbage");
          const disposed = await page.evaluate<MediaSnapshot>(() =>
            window.controlUiMediaBench.read(),
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
            status: "passed",
            errors,
            loadMs,
            scrollMs,
            stable,
            scrolled,
            disposed,
            layoutShiftPhaseSums: {
              load: stable.layoutShiftSum,
              scroll:
                scrolled.layoutShiftSum === null || stable.layoutShiftSum === null
                  ? null
                  : scrolled.layoutShiftSum - stable.layoutShiftSum,
              disposal:
                disposed.layoutShiftSum === null || scrolled.layoutShiftSum === null
                  ? null
                  : disposed.layoutShiftSum - scrolled.layoutShiftSum,
            },
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
            milliseconds:
              before && loaded && beforeScroll && afterScroll
                ? Object.fromEntries(
                    ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
                      (name) => [
                        name,
                        1000 *
                          (loaded[name]! -
                            before[name]! +
                            afterScroll[name]! -
                            beforeScroll[name]!),
                      ],
                    ),
                  )
                : undefined,
          });
        } catch (error) {
          result.error = `${String(error)} (page: ${page.url()})`;
          result.errors = errors;
          await page
            .screenshot({ path: path.join(artifactDir, `${prefix}-failed.png`) })
            .catch(() => undefined);
        } finally {
          releaseMedia();
          result.consoleErrors = consoleErrors;
          result.failedRequests = failedRequests;
          result.pageErrors = pageErrors;
          result.httpErrors = httpErrors;
          if (tracing && cdp) {
            await cdp.send("Tracing.end").catch(() => undefined);
          }
          const fetchAttempts = await page
            .evaluate<MediaFetchAttempt[] | null>(
              () => window.controlUiMediaBench?.readFetches() ?? null,
            )
            .catch(() => null);
          const classification = classifyMediaErrors({
            engine,
            origin: slot.server.baseUrl,
            pageErrors,
            httpErrors,
            consoleErrors,
            failedRequests,
            fetchAttempts: fetchAttempts ?? [],
          });
          Object.assign(result, classification);
          if (classification.unexpectedErrors.length) {
            result.status = "failed";
          }
          result.cacheProbe = {
            transport: "native-http",
            browserHttpCache: "enabled",
            serverRequests: slot.server.requests
              .slice(serverRequestOffset)
              .filter((request) => mediaKind(new URL(request.url, slot.server.baseUrl))),
            fetchAttempts: fetchAttempts
              ? {
                  cacheOnly: fetchAttempts.filter((attempt) => attempt.cache === "only-if-cached"),
                  networkEligible: fetchAttempts.filter(
                    (attempt) => attempt.cache !== "only-if-cached",
                  ),
                }
              : null,
            // Server requests are wire admissions, not decoded bytes or complete downloads.
            networkDownloads: null,
          };
          results.push(result);
          await writeFile(
            path.join(artifactDir, `${prefix}.json`),
            JSON.stringify(result, null, 2),
          );
          await cdp?.detach();
          await context.close();
        }
        console.log(
          JSON.stringify({
            engine,
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
        engine,
        durationClock: engine === "chromium" ? "threadTicks" : "wall-only",
        geometrySampling: values.geometry
          ? "rAF during held-media release only; forced geometry reads add overhead"
          : "disabled",
        bundles: servers.map(({ server: _server, ...item }) => item),
        fixture: {
          messages: 96,
          uniqueImages: 16,
          imageSize: [1600, 900],
          thumbnailBytes: Object.fromEntries(
            [...thumbnails].map(([width, bytes]) => [width, bytes.length]),
          ),
          dimensions: values.dimensions,
          uniqueHosts: 8,
          avatars: 120,
        },
        timing,
        results,
        layoutShiftScope:
          "Non-recent-input entries since the held-media release reset, through each load/scroll/disposal snapshot. maxSessionWindowShift is the largest reset-bounded window (gap <1000ms, duration <5000ms), not navigation-lifetime CLS. Media attribution includes a whole entry when any source contains media.",
        acceptance:
          "Zero stable-viewport media-attributed shift sum; compare browser admissions, cache-only fetch attempts and server HTTP requests before attributing application reuse; inspect live blobs after native app-host disconnection without document reload. >=10 AB/BA pairs: median <=5% regression and p95 not worse; noisy hosts require a separate A/A control and 20 pairs judged by CDP CPU plus structural counters.",
        limitations:
          "Synthetic Gateway RPC has no RTT. Static HTTP is unthrottled and outside the measured interval. Remote media HTTP responses use one server-side100ms/shared10Mbps delay in both engines; browser-cache-only reads never reach that delay. Browser request events include cache hits; server requests count wire admissions, not completed downloads. WebKit has no CDP CPU/heap/trace metrics. Unsupported native Layout Instability is reported as null, not zero; geometry changes are diagnostic rectangles, not CLS. CDP durations include media load and scroll, not navigation or disposal; heap metrics are JS heap only, not native decoded-image memory. No total decoded-memory claim.",
      },
      null,
      2,
    ),
  );
}
if (results.some((row) => row.status !== "passed")) {
  process.exitCode = 1;
}
