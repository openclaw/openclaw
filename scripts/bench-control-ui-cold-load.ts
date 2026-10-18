// Opt-in production-bundle benchmark; real delays model wire delivery, not test synchronization.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import { buildSandboxHostPath } from "../src/agents/sandbox-host.js";
import { createSandboxHostHttpServer } from "../src/gateway/mcp-app-sandbox-http.js";
import { installColdLoadProbes } from "../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  controlUiSessionUrl,
  controlUiBundledSettingsStorageKey,
  prepareControlUiMockGatewayScenario,
  resolvePlaywrightChromiumExecutablePath,
  startProductionControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../ui/src/test-helpers/control-ui-team-scale-fixture.ts";
import {
  mapColdLoadCpuProfile,
  prepareColdLoadTraceEvent,
  summarizeColdLoadTrace,
  summarizeCpuProfile,
} from "./lib/control-ui-cold-load-trace.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "latency-ms": { type: "string", default: "35" },
    "frame-gap-ms": { type: "string", default: "4" },
    "sidebar-view": { type: "string", default: "sessions" },
    output: { type: "string", default: ".artifacts/control-ui-cold-load" },
  },
});
const sidebarView = values["sidebar-view"];
if (sidebarView !== "sessions" && sidebarView !== "online") {
  throw new Error("Expected sidebar-view sessions or online");
}
const runs = Number(values.runs);
const latencyMs = Number(values["latency-ms"]);
const frameGapMs = Number(values["frame-gap-ms"]);
if (
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 20 ||
  !Number.isFinite(latencyMs) ||
  latencyMs < 0 ||
  !Number.isFinite(frameGapMs) ||
  frameGapMs < 0
) {
  throw new Error("Expected 1–20 runs and nonnegative finite wire delays");
}
const artifactDir = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
await mkdir(artifactDir, { recursive: true });
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
const server = await startProductionControlUiE2eServer(path.join(artifactDir, "ui"), head);
const sandbox = createSandboxHostHttpServer();
await new Promise<void>((resolve, reject) => {
  sandbox.once("error", reject);
  sandbox.listen(0, "127.0.0.1", resolve);
});
const address = sandbox.address();
if (!address || typeof address === "string") {
  throw new Error("Sandbox did not bind");
}
const fixture = createControlUiTeamScaleFixture({
  baseUrl: server.baseUrl,
  sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
  sandboxPort: address.port,
});
let browser: Browser | undefined;
const results = [];
try {
  const prepared = await prepareControlUiMockGatewayScenario({
    ...fixture.scenario,
    serverBuildId: head,
    serverVersion: JSON.parse(await readFile("package.json", "utf8")).version,
  });
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1719, height: 1179 },
    serviceWorkers: "block",
    permissions: ["local-network-access"],
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const harnessWarnings: string[] = [];
  page.on("pageerror", (error) => {
    // Playwright's serviceWorkers:block init script also runs in opaque sandbox frames.
    if (
      error.name === "SecurityError" &&
      error.message ===
        "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag." &&
      error.stack?.includes("at <anonymous>:3:15")
    ) {
      harnessWarnings.push(error.message);
    } else {
      errors.push(error.message);
    }
  });
  await page.route("**/control-ui-config.json", (route) =>
    route.fulfill({ json: createControlUiMockBootstrapConfig(prepared.scenario) }),
  );
  const assets = new Map<string, { body: string | Buffer; contentType: string }>([
    ...fixture.assets,
    ...prepared.assets,
  ]);
  await page.route("**/__openclaw__/**", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return asset ? route.fulfill({ status: 200, ...asset }) : route.fallback();
  });
  await page.addInitScript(
    ({ key, pins }) => {
      if (window !== window.top) {
        return;
      }
      if (!localStorage.getItem(key)) {
        localStorage.setItem(
          key,
          JSON.stringify({
            sidebarAgentsMode: "roster",
            railShortcuts: pins,
            navigationByProfile: { "team-person-001": { railShortcuts: pins } },
          }),
        );
      }
    },
    {
      key: controlUiBundledSettingsStorageKey(server.baseUrl),
      pins: fixture.sidebarEntries,
    },
  );
  await page.addInitScript({
    content: `;(() => { if (window !== window.top) return; ${createControlUiMockGatewayInitScript(prepared.scenario)}\n(${installColdLoadProbes.toString()})(${JSON.stringify({ latencyMs, frameGapMs, events: fixture.events })}); })();`,
  });
  const url = controlUiSessionUrl(server.baseUrl, fixture.selectedSessionKey, "dashboard");
  async function settle() {
    try {
      await page
        .locator(".chat-pane__session-title-text", { hasText: "Project dashboard 1" })
        .waitFor();
      await page
        .locator('.sidebar-rail [data-sidebar-entry^="session:"]')
        .nth(29)
        .waitFor({ state: "attached" });
      await page.locator('[data-sidebar-entry="plugin:team-scale-6/overview"]').waitFor();
      if (sidebarView === "online") {
        await page.locator('[data-online-user-id="team-person-120"]').waitFor();
      }
      await page
        .frameLocator(".board-widget__frame")
        .frameLocator("iframe")
        .getByText("Team metric 1", { exact: true })
        .waitFor();
      await page
        .frameLocator(".chat-tool-card__preview-frame")
        .last()
        .frameLocator("iframe")
        .getByText("Team metric 12", { exact: true })
        .waitFor();
      await page.waitForFunction(
        (eventCount) => {
          const state = Reflect.get(window, "__coldLoad")?.read();
          return (
            state &&
            state.sentEvents === eventCount &&
            !state.pending &&
            !state.queued &&
            state.idleMs > 750
          );
        },
        fixture.events.length,
        { timeout: 30_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => Reflect.get(window, "__coldLoad")?.read());
      await writeFile(
        path.join(artifactDir, "failure.json"),
        JSON.stringify({ diagnostics, errors }, null, 2),
      );
      await page.screenshot({ path: path.join(artifactDir, "failure.png") });
      console.error(JSON.stringify({ diagnostics, errors }));
      throw error;
    }
  }
  await page.goto(url);
  await page.locator("#sidebar-session-owner-title").click();
  await page.locator('.sidebar-session-owner-filter [role="option"][data-value="all"]').click();
  if (sidebarView === "online") {
    await page.locator('[data-navigation-view="online"]').click();
  }
  await settle();
  await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
  for (let run = 0; run < runs; run++) {
    const cdp = await context.newCDPSession(page);
    const rawTrace: unknown[] = [];
    cdp.on("Tracing.dataCollected", (data) => rawTrace.push(...data.value));
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    await cdp.send("Profiler.start");
    await cdp.send("Tracing.start", {
      categories:
        "toplevel,loading,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.screenshot,v8",
      transferMode: "ReportEvents",
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle();
    const metrics = await page.evaluate(() => Reflect.get(window, "__coldLoad").read());
    await writeFile(path.join(artifactDir, `run-${run + 1}.metrics.json`), JSON.stringify(metrics));
    const profile = await cdp.send("Profiler.stop");
    const complete = new Promise<void>((resolve) => {
      cdp.once("Tracing.tracingComplete", () => resolve());
    });
    await cdp.send("Tracing.end");
    await complete;
    await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.png`) });
    await writeFile(
      path.join(artifactDir, `run-${run + 1}.trace.json`),
      JSON.stringify({ traceEvents: rawTrace }),
    );
    await writeFile(
      path.join(artifactDir, `run-${run + 1}.cpuprofile`),
      JSON.stringify(profile.profile),
    );
    const trace = rawTrace.map(prepareColdLoadTraceEvent);
    const screenshots = trace.flatMap((event) =>
      event.name === "Screenshot" && event.args?.snapshot
        ? [{ ts: event.ts, data: event.args.snapshot }]
        : [],
    );
    const visual = await page.evaluate(async (frames) => {
      const canvas = document.createElement("canvas");
      canvas.width = 344;
      canvas.height = 236;
      const ctx = canvas.getContext("2d")!;
      let previous: DataView | undefined;
      let lastChange: number | undefined;
      let significantFrames = 0;
      let transitionGroups = 0;
      for (const frame of frames) {
        const image = new Image();
        image.src = `data:image/jpeg;base64,${frame.data}`;
        await image.decode();
        ctx.drawImage(image, 0, 0, 344, 236);
        const bytes = ctx.getImageData(0, 0, 344, 236).data;
        const pixels = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (previous) {
          let changed = 0;
          for (let i = 0; i < pixels.byteLength; i += 4) {
            if (
              Math.max(
                Math.abs(pixels.getUint8(i) - previous.getUint8(i)),
                Math.abs(pixels.getUint8(i + 1) - previous.getUint8(i + 1)),
                Math.abs(pixels.getUint8(i + 2) - previous.getUint8(i + 2)),
              ) >= 32
            ) {
              changed++;
            }
          }
          if (changed / (344 * 236) >= 0.004) {
            significantFrames++;
            if (lastChange === undefined || frame.ts - lastChange > 100_000) {
              transitionGroups++;
            }
            lastChange = frame.ts;
          }
        }
        previous = pixels;
      }
      return {
        frames: frames.length,
        significantFrames,
        transitionGroups,
      };
    }, screenshots);
    const mapped = await mapColdLoadCpuProfile(profile.profile, {
      assetBaseUrl: new URL("assets/", server.baseUrl).href,
      assetDirectory: path.join(artifactDir, "ui", "assets"),
    });
    const result = {
      run: run + 1,
      ...metrics,
      trace: summarizeColdLoadTrace(trace, metrics.at),
      cpu: summarizeCpuProfile(mapped.profile),
      mappedFrames: mapped.mappedFrames,
      unmappedFrames: mapped.unmappedFrames,
      harnessWarnings,
      visual,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    await cdp.detach();
  }
  if (errors.length) {
    throw new Error(`Browser errors: ${errors.join("\n")}`);
  }
  await context.close();
} finally {
  await browser?.close();
  await server.close();
  sandbox.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    sandbox.close((error) => (error ? reject(error) : resolve()));
  });
  await writeFile(
    path.join(artifactDir, "summary.json"),
    JSON.stringify(
      { head, dirty, fixture: fixture.counts, sidebarView, latencyMs, frameGapMs, results },
      null,
      2,
    ),
  );
  console.log(`Cold-load artifacts: ${artifactDir}`);
}
