// Real built Gateway + synthetic durable state; never accepts an arbitrary live URL.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { installWarmReloadBrowserProbe, proofRegions } from "./warm-reload-browser-probe.ts";
import { seedWarmReloadFixture } from "./warm-reload-fixture.ts";
import { analyzeReloadFrames, type ReloadFrame } from "./warm-reload-frames.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string", default: ".local/warm-reload-proof" },
    dist: { type: "string", default: "dist" },
    "ui-root": { type: "string" },
    reloads: { type: "string", default: "11" },
    sessions: { type: "string", default: "3000" },
    "rtt-ms": { type: "string", default: "80" },
    "capture-ms": { type: "string", default: "8000" },
    route: { type: "string", default: "both" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.info(`Usage: node --import ./scripts/tsx.mjs scripts/perf/warm-reload-proof.ts
  --dist dist --ui-root dist/control-ui --output .local/warm-reload-proof
  --reloads 11 --sessions 3000 --rtt-ms 80 --capture-ms 8000 --route both|chat|dashboard
Creates fresh isolated state and Chromium, records cold + warm reloads, then stops both.
See scripts/perf/warm-reload-proof.md for metric definitions and limitations.`);
  process.exit(0);
}
function integer(raw: string, name: string, min: number, max: number) {
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return number;
}
const reloads = integer(values.reloads, "--reloads", 0, 100);
const sessions = integer(values.sessions, "--sessions", 2000, 20000);
const rttMs = integer(values["rtt-ms"], "--rtt-ms", 0, 1000);
const captureMs = integer(values["capture-ms"], "--capture-ms", 1000, 60000);
if (!["both", "chat", "dashboard"].includes(values.route)) {
  throw new Error("--route must be both, chat, or dashboard");
}
const dist = path.resolve(values.dist);
const uiRoot = path.resolve(values["ui-root"] ?? path.join(dist, "control-ui"));
await Promise.all([access(path.join(dist, "entry.js")), access(path.join(uiRoot, "index.html"))]);
const directory = createControlUiE2eArtifactDir("warm-reload", values.output);
const stateDir = path.join(directory, "state");
const viewport = { width: 1720, height: 1180 };
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

async function freePort() {
  for (let port = 19600; port <= 19699; port++) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  throw new Error("No free loopback port in 19600–19699");
}

async function waitForGateway(url: string, child: ChildProcess) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Owned Gateway exited during startup; inspect gateway.log");
    }
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Startup readiness is outside the measured navigation interval.
    }
    await delay(250);
  }
  throw new Error("Owned Gateway did not become healthy; inspect gateway.log");
}

async function readProbe(page: Page) {
  return await page.evaluate(() => {
    const data: NonNullable<ReturnType<typeof installWarmReloadBrowserProbe>> = Reflect.get(
      window,
      "__warmReloadProof",
    );
    data.stopped = true;
    return { ...data, timeOrigin: performance.timeOrigin, capturedUntilMs: performance.now() };
  });
}
async function regionBoxes(page: Page) {
  return await page.evaluate((selectors) => {
    return Object.entries(selectors).flatMap(([name, selector]) => {
      const elements = [...document.querySelectorAll(selector)];
      const boxes = elements
        .map((element) => element.getBoundingClientRect())
        .filter(
          (box) =>
            box.width > 0 &&
            box.height > 0 &&
            box.right > 0 &&
            box.bottom > 0 &&
            box.x < innerWidth &&
            box.y < innerHeight,
        );
      if (!boxes.length) {
        return [];
      }
      const x = Math.max(0, Math.min(...boxes.map((box) => box.x)));
      const y = Math.max(0, Math.min(...boxes.map((box) => box.y)));
      return [
        {
          name,
          x,
          y,
          width: Math.min(innerWidth, Math.max(...boxes.map((box) => box.right))) - x,
          height: Math.min(innerHeight, Math.max(...boxes.map((box) => box.bottom))) - y,
        },
      ];
    });
  }, proofRegions);
}

type WireFrame = { file: string; epochMs: number };
async function captureReload(
  page: Page,
  cdp: CDPSession,
  url: string,
  outputDir: string,
  warm: boolean,
) {
  await mkdir(outputDir, { recursive: true });
  const frames: WireFrame[] = [];
  const writes: Promise<void>[] = [];
  const errors: string[] = [];
  const http: Array<{ url: string; status: number; type: string; atMs: number }> = [];
  const requests = new Map<string, { method: string; atMs: number; bytes: number }>();
  const rpc: Array<{
    method: string;
    atMs: number;
    responseAtMs?: number;
    bytes: number;
    responseBytes?: number;
  }> = [];
  const onFrame = (event: {
    data: string;
    sessionId: number;
    metadata: { timestamp?: number };
  }) => {
    const file = path.join(outputDir, `frame-${String(frames.length).padStart(5, "0")}.png`);
    frames.push({ file, epochMs: (event.metadata.timestamp ?? Date.now() / 1000) * 1000 });
    writes.push(writeFile(file, Buffer.from(event.data, "base64")));
    writes.push(cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).then(() => {}));
  };
  const onError = (error: Error) => errors.push(error.message);
  const onHttp = (event: { type: string; response: { url: string; status: number } }) => {
    if (event.response.url.startsWith("http")) {
      http.push({
        url: event.response.url,
        status: event.response.status,
        type: event.type,
        atMs: Date.now(),
      });
    }
  };
  const onSent = (event: { response: { payloadData: string } }) => {
    const frame: { type?: string; id?: string; method?: string } = JSON.parse(
      event.response.payloadData,
    );
    if (frame.type === "req" && frame.id && frame.method) {
      const row = {
        method: frame.method,
        atMs: Date.now(),
        bytes: Buffer.byteLength(event.response.payloadData),
      };
      requests.set(frame.id, row);
      rpc.push(row);
    }
  };
  const onReceived = (event: { response: { payloadData: string } }) => {
    const frame: { type?: string; id?: string } = JSON.parse(event.response.payloadData);
    const row = frame.id ? requests.get(frame.id) : undefined;
    if (frame.type === "res" && row) {
      Object.assign(row, {
        responseAtMs: Date.now(),
        responseBytes: Buffer.byteLength(event.response.payloadData),
      });
    }
  };
  cdp.on("Page.screencastFrame", onFrame);
  cdp.on("Network.responseReceived", onHttp);
  cdp.on("Network.webSocketFrameSent", onSent);
  cdp.on("Network.webSocketFrameReceived", onReceived);
  page.on("pageerror", onError);
  try {
    await cdp.send("Page.startScreencast", {
      format: "png",
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    });
    if (warm) {
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    // Fixed observation windows are the measured workload, not test synchronization.
    await page.waitForFunction((duration) => performance.now() >= duration, captureMs, {
      timeout: captureMs + 60000,
    });
    const probe = await readProbe(page);
    for (const response of http) {
      response.atMs -= probe.timeOrigin;
    }
    for (const request of rpc) {
      request.atMs -= probe.timeOrigin;
      if (request.responseAtMs !== undefined) {
        request.responseAtMs -= probe.timeOrigin;
      }
    }
    const regions = await regionBoxes(page);
    await page.screenshot({ path: path.join(outputDir, "final.png") });
    await cdp.send("Page.stopScreencast");
    await Promise.all(writes);
    const ordered: ReloadFrame[] = frames
      .map((frame) => ({ file: frame.file, atMs: frame.epochMs - probe.timeOrigin }))
      .filter((frame) => frame.atMs >= 0);
    await writeFile(
      path.join(outputDir, "frames.json"),
      JSON.stringify({ frames, navigationTimeOrigin: probe.timeOrigin }, null, 2),
    );
    if (!ordered.length || !probe.helloHandledMs || !probe.firstMainDomMs) {
      throw new Error(
        `Incomplete capture: ${JSON.stringify({ frames: ordered.length, probe, errors })}`,
      );
    }
    const visual = await analyzeReloadFrames({
      frames: ordered,
      regions,
      masks: probe.masks,
      outputDir,
    });
    const paintedAfter = (atMs: number | null) =>
      atMs === null
        ? null
        : (ordered.find((frame) => frame.atMs >= Math.max(atMs, probe.fcpMs ?? 0))?.atMs ?? null);
    const report = {
      warm,
      url: new URL(url).pathname,
      probe,
      firstAppCapturedPaintMs: paintedAfter(probe.firstAppDomMs),
      firstMainCapturedPaintMs: paintedAfter(probe.firstMainDomMs),
      regions,
      visual,
      observationCensored:
        visual.lastVisualChangeMs !== null &&
        probe.capturedUntilMs - visual.lastVisualChangeMs < 1000,
      rpc,
      http,
      errors,
      outputDir,
    };
    await writeFile(path.join(outputDir, "reload.json"), JSON.stringify(report, null, 2));
    console.info(
      JSON.stringify({
        reload: outputDir,
        helloHandledMs: probe.helloHandledMs,
        firstMainCapturedPaintMs: report.firstMainCapturedPaintMs,
        cls: probe.cls,
      }),
    );
    return report;
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    cdp.off("Page.screencastFrame", onFrame);
    cdp.off("Network.responseReceived", onHttp);
    cdp.off("Network.webSocketFrameSent", onSent);
    cdp.off("Network.webSocketFrameReceived", onReceived);
    page.off("pageerror", onError);
    await Promise.allSettled(writes);
  }
}

let gateway: ChildProcess | undefined;
let browser: Browser | undefined;
let fixture: Awaited<ReturnType<typeof seedWarmReloadFixture>> | undefined;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  process.exitCode = 130;
  void browser?.close().catch(() => {});
  gateway?.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
try {
  fixture = await seedWarmReloadFixture({ stateDir, port, uiRoot, sessions });
  if (interrupted) {
    throw new Error("Proof interrupted during fixture preparation");
  }
  const log = createWriteStream(path.join(directory, "gateway.log"));
  gateway = spawn(
    process.execPath,
    [
      path.join(dist, "entry.js"),
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--auth",
      "token",
      "--token",
      fixture.token,
      "--allow-unconfigured",
    ],
    { env: fixture.env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  gateway.stdout?.pipe(log);
  gateway.stderr?.pipe(log);
  gateway.once("error", (error) => console.error("Gateway spawn failed:", error.message));
  await waitForGateway(baseUrl, gateway);
  const client = createGatewayWsClient({ url: baseUrl.replace("http", "ws"), origin: baseUrl });
  try {
    await client.waitOpen();
    const connected = await client.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "cli", version: "warm-reload-proof", platform: process.platform, mode: "cli" },
      role: "operator",
      scopes: ["operator.admin"],
      auth: { token: fixture.token },
    });
    if (!connected.ok) {
      throw new Error(`Synthetic fixture RPC admission failed: ${JSON.stringify(connected.error)}`);
    }
    await fixture.prepareGateway(async (method, params) => {
      const response = await client.request(method, params);
      if (!response.ok) {
        throw new Error(`${method}: ${JSON.stringify(response.error)}`);
      }
      return response.payload;
    });
  } finally {
    client.close();
  }
  browser = await chromium.launch({ headless: true });
  if (interrupted) {
    throw new Error("Proof interrupted during browser launch");
  }
  const results = [];
  for (const [route, routePath] of [
    ["chat", fixture.chatPath],
    ["dashboard", fixture.dashboardPath],
  ] as const) {
    if (values.route !== "both" && values.route !== route) {
      continue;
    }
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      await page.addInitScript({
        content: `const __name = (fn) => fn; (${installWarmReloadBrowserProbe.toString()})(${JSON.stringify(route)});`,
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.clearBrowserCache");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: rttMs,
        downloadThroughput: 10 * 1024 * 1024,
        uploadThroughput: 10 * 1024 * 1024,
        connectionType: "wifi",
      });
      const url = `${baseUrl}${routePath}#token=${encodeURIComponent(fixture.token)}`;
      results.push({
        route,
        runs: [await captureReload(page, cdp, url, path.join(directory, route, "cold"), false)],
      });
      const details = page.locator(".chat-details-toggle:visible");
      if (
        (await details.count()) &&
        (await details.first().getAttribute("aria-expanded")) !== "true"
      ) {
        await details.first().click();
      }
      // Let existing cache owners persist the fully loaded route before warm samples.
      await page.waitForFunction(
        () =>
          document.fonts.status === "loaded" &&
          [...document.images].every((image) => image.complete),
      );
      await delay(2000);
      for (let index = 1; index <= reloads; index++) {
        results
          .at(-1)!
          .runs.push(
            await captureReload(
              page,
              cdp,
              url,
              path.join(directory, route, `warm-${String(index).padStart(2, "0")}`),
              true,
            ),
          );
      }
      await cdp.detach();
    } finally {
      await context.close();
    }
  }
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(
      {
        revision,
        dist,
        uiRoot,
        viewport,
        rttMs,
        captureMs,
        reloads,
        fixture: fixture.fixtureSummary,
        host: {
          hostname: os.hostname(),
          cpus: os.cpus().length,
          load: os.loadavg(),
          chromium: browser.version(),
        },
        measurement:
          "PNG screencast diagnostic; compositor frames Chromium delivers, everyNthFrame=1; no guarantee of display-vsync completeness. Paint bounds use first captured frame after DOM readiness/FCP. HTTP CDP latency does not delay individual WebSocket frames. No product performance change is compared.",
        results,
      },
      null,
      2,
    ),
  );
  console.info(`Retained proof: ${directory}/report.json`);
} finally {
  for (const close of [
    () => browser?.close(),
    () => (gateway ? stopChild(gateway, { teardownGraceMs: 10000 }) : undefined),
    () => fixture?.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      console.error("Owned proof resource cleanup failed:", error);
      process.exitCode = 1;
    }
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
