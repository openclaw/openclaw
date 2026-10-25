import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildSandboxHostDocument, buildSandboxHostPath } from "../../src/agents/sandbox-host.ts";
import type { RouteId } from "../../ui/src/app-route-paths.ts";
import { openSessionMenuSubmenu } from "../../ui/src/e2e/session-management.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
  navigateToControlUiSession,
  resolvePlaywrightChromiumExecutablePath,
  startBuiltControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  appHtml,
  findAppFrame,
  readMcpAppModule,
} from "../../ui/src/test-helpers/mcp-app-conformance-fixture.ts";
import { baseScenario, scenes } from "../control-ui-parity/scenarios.ts";
import { createInteractionFixture } from "../lib/control-ui-interaction-scenarios.ts";
import {
  captureRetention,
  installRetentionTimers,
  settleRetention,
} from "../lib/control-ui-retention.ts";
import {
  additionalDialogCoverageNotes,
  additionalDialogScenes,
} from "./additional-dialog-scenes.ts";
import { dialogScenes } from "./dialog-scenes.ts";
import { documentScenes } from "./document-scenes.ts";
import { finalDialogCoverageLimits, finalDialogScenes } from "./final-dialog-scenes.ts";
import { resourceDialogScenes } from "./resource-dialog-scenes.ts";
import { specialDialogCoverageNotes, specialDialogScenes } from "./special-dialog-scenes.ts";

const bundleDir = path.resolve(process.env.OPENCLAW_RETENTION_BUNDLE ?? "dist/control-ui");
const filter = new RegExp(process.env.OPENCLAW_RETENTION_FILTER ?? ".", "u");
const clawsConfig = { gateway: { controlUi: { experimental: { claws: true } } } };
const dialogIds = new Set([
  "session-modal",
  "session-menu",
  "session-submenu",
  "model-long-list",
  "permission-selected",
  "models-login-providers",
  "models-login-methods",
  "models-login-step",
]);
const selectedScenes = [
  ...scenes.filter(
    (scene) => scene.route && (scene.id.startsWith("route-") || dialogIds.has(scene.id)),
  ),
  ...dialogScenes,
  ...resourceDialogScenes,
  ...finalDialogScenes,
  ...specialDialogScenes,
  ...additionalDialogScenes,
]
  .filter((scene) => filter.test(scene.id))
  .map((scene) =>
    scene.id === "route-claws"
      ? Object.assign({}, scene, {
          ready: ".agents-home__claw-empty",
          scenario: {
            featureMethods: [...baseScenario.featureMethods!, "claws.catalog.search"],
            methodResponses: {
              "config.get": {
                config: clawsConfig,
                raw: JSON.stringify(clawsConfig),
                hash: "retention-claws",
                valid: true,
                issues: [],
              },
              "claws.catalog.search": { entries: [] },
            },
          },
        })
      : scene,
  );
const selectedWorkloads = [
  ...selectedScenes.map((scene) => scene.id),
  ...documentScenes.filter((scene) => filter.test(scene.id)).map((scene) => scene.id),
  ...["session-switch", "stream", "reconnect", "dialog-mcp-confirmation"].filter((id) =>
    filter.test(id),
  ),
];
if (!selectedWorkloads.length) {
  throw new Error("Retention selection matches no workloads");
}
const directory = createControlUiE2eArtifactDir("retention", process.env.OPENCLAW_RETENTION_OUTPUT);
const samples: Array<{
  workload: string;
  cycle: number;
  metrics: Awaited<ReturnType<typeof captureRetention>>;
}> = [];
const coverage: Array<{ workload: string; outcome: string }> = [];
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let server: Awaited<ReturnType<typeof startBuiltControlUiE2eServer>>;
let build: { buildId: string; version: string };

beforeAll(async () => {
  const html = await readFile(path.join(bundleDir, "index.html"), "utf8");
  const identity = html.match(
    /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
  )?.[1];
  if (!identity) {
    throw new Error("Production bundle has no build identity");
  }
  build = JSON.parse(identity);
  server = await startBuiltControlUiE2eServer(bundleDir);
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: true,
    args: ["--use-fake-device-for-media-stream"],
  });
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        build,
        bundleDir,
        browser: browser.version(),
        platform: process.platform,
        arch: process.arch,
        load: os.loadavg(),
        filter: filter.source,
        planned: selectedWorkloads,
        acceptance:
          "Report-only census. Warm repeated workloads should plateau after bounded caches fill; rank sustained growth by post-GC bytes/cycle and inspect strong retainers before changing owners.",
        instrumentation:
          "Production renderer; synthetic Gateway; native clocks; timer ID sets retain no callbacks; uninterrupted CDP profiler; Solid rc.18 production owner slots (_parent/De/He/R), disposed bit 64; detachedness=2 native nodes. Heap counters include the mock and probe overhead.",
        exclusions:
          "Standalone approval/question and boot-only Gateway confirmation use repeated full-document navigation; all other workloads preserve the SPA document. Native OS pickers, Linux companion dialogs, arbitrary third-party dialogs, and every visual/loading/error variant are outside this census.",
        coverageLimits: finalDialogCoverageLimits,
        coverageNotes: [...specialDialogCoverageNotes, ...additionalDialogCoverageNotes],
      },
      null,
      2,
    ),
  );
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await writeFile(
    path.join(directory, "census.json"),
    JSON.stringify({ samples, coverage }, null, 2),
  );
  const rows = coverage.flatMap(({ workload, outcome }) => {
    const checkpoints = samples.filter((sample) => sample.workload === workload);
    const status = outcome === "passed" ? "passed" : "failed (see census.json)";
    if (checkpoints.length < 2) {
      return [`| ${workload} | ${status} | — | — | — | — | — | — |`];
    }
    return checkpoints.slice(1).map((last, index) => {
      const first = checkpoints[index]!;
      const delta = last.metrics.heapUsedBytes - first.metrics.heapUsedBytes;
      const listeners = Object.values(last.metrics.listeners)
        .flatMap((types) => Object.values(types))
        .reduce((a, b) => a + b, 0);
      const interval =
        workload === "stream" && last.cycle === 2_001
          ? "finalization"
          : `${first.cycle}–${last.cycle}`;
      return `| ${workload} | ${status} | ${interval} | ${Math.round(delta / (last.cycle - first.cycle))} | ${last.metrics.detachedNodes} | ${last.metrics.solidLiveOwners} | ${listeners} | ${last.metrics.timers.timeouts}/${last.metrics.timers.intervals} |`;
    });
  });
  await writeFile(
    path.join(directory, "summary.md"),
    [
      "| Workload | Outcome | Measured interval | Heap B/unit | Detached DOM | Live Solid owners | Global listeners | Timeouts/intervals |",
      "|---|---|---:|---:|---:|---:|---:|---:|",
      ...rows,
      "",
      "Report-only; intervals differ by workload. Inspect retained paths before classifying growth as a leak. See census.json for all checkpoints and coverage outcomes.",
    ].join("\n"),
  );
  console.log(`Retention census: ${directory}`);
});

async function navigate(page: Page, routeId: RouteId, destinationPath: string) {
  const session = new URL(destinationPath, server.baseUrl).searchParams.get("session");
  if (routeId === "chat" && session) {
    await navigateToControlUiSession(page, session);
    await settleRetention(page);
    return;
  }
  await page.waitForFunction(() => window.openclawControlUi !== undefined);
  await page.evaluate(
    ({ route, destination }) => {
      const url = new URL(destination, location.href);
      window.openclawControlUi!.navigate(route, {
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
      });
    },
    { route: routeId, destination: destinationPath },
  );
  await waitForControlUiRoute(page, { routeId });
  await settleRetention(page);
}

async function measure(
  workload: string,
  fixture: ControlUiMockGatewayScenario,
  run: (
    page: Page,
    gateway: MockGatewayControls,
    sample: (cycle: number) => Promise<void>,
  ) => Promise<void>,
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript("globalThis.__name = (fn) => fn");
  await installRetentionTimers(page);
  const gateway = await installMockGateway(page, {
    ...fixture,
    serverBuildId: build.buildId,
    serverVersion: build.version,
  });
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await page.goto(new URL("/new", server.baseUrl).href);
    await waitForControlUiRoute(page, { routeId: "new-session" });
    await run(page, gateway, async (cycle) => {
      // Canvas retirement takes 1 s; reconnect feedback can remain for 4 s.
      // Drain these documented lifetimes before calling survivors leaks.
      await page.waitForTimeout(4_100);
      const metrics = await captureRetention(
        page,
        cdp,
        path.join(directory, `${workload}-${cycle}.heapsnapshot`),
      );
      expect(
        metrics.solidUnknownStateOwners,
        "Every counted owner needs a decoded live/disposed flag",
      ).toBe(0);
      samples.push({ workload, cycle, metrics });
      await writeFile(
        path.join(directory, "census.json"),
        JSON.stringify({ samples, coverage }, null, 2),
      );
      console.log(
        JSON.stringify({ workload, cycle, ...metrics, detached: undefined, listeners: undefined }),
      );
    });
    expect(errors).toEqual([]);
    coverage.push({ workload, outcome: "passed" });
  } catch (error) {
    coverage.push({ workload, outcome: String(error) });
    await captureControlUiE2eFailureDiagnostics(page, {
      error: error instanceof Error ? error : new Error(String(error)),
      label: workload,
      pageErrors: errors,
    });
    // A stalled font load is one retention trigger; Playwright screenshots wait
    // for fonts.ready and could hide the original failure behind that wait.
    const screenshot = await cdp.send("Page.captureScreenshot");
    await writeFile(
      path.join(directory, `${workload}-failed.png`),
      Buffer.from(screenshot.data, "base64"),
    );
    throw error;
  } finally {
    await cdp.detach();
    await context.close();
  }
}

// Reuse the existing route and interaction recipes; navigation never reloads
// the document, so retiring a page must really release its owner graph.
for (const scene of selectedScenes) {
  const workload = scene.id;
  it(
    workload,
    async () => {
      await measure(
        workload,
        {
          ...baseScenario,
          ...scene.scenario,
          methodResponses: { ...baseScenario.methodResponses, ...scene.scenario?.methodResponses },
        },
        async (page, gateway, sample) => {
          const visit = async () => {
            await navigate(page, scene.route!, scene.path);
            await page.locator(scene.ready).first().waitFor();
            if (scene.id === "session-submenu") {
              // Repeated visits retain pointer coordinates; use the keyboard path.
              await page.locator(".chat-header-session-menu__trigger").focus();
              await page.keyboard.press("Enter");
              await openSessionMenuSubmenu(page, "Advanced");
              await openSessionMenuSubmenu(page, "Icon & color");
              await page.locator(".session-menu__appearance:visible").waitFor();
              await page.getByRole("button", { name: "Blue", exact: true }).waitFor();
            } else {
              await scene.prepare?.(page, gateway);
            }
            await settleRetention(page);
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            // Retire New Session too; the private-recovery case deliberately
            // reopens one blocked draft without discarding its owning page.
            if (scene.route === "new-session" && scene.id !== "dialog-private-composer-recovery") {
              await navigate(page, "appearance", "/settings/appearance");
            } else {
              await navigate(page, "new-session", "/new");
            }
            await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
          };
          await visit();
          await sample(0);
          for (let cycle = 1; cycle <= 10; cycle++) {
            await visit();
            if (cycle === 5 || cycle === 10) {
              await sample(cycle);
            }
          }
        },
      );
    },
    scene.id === "dialog-browser-auth-recovery" ? 600_000 : undefined,
  );
}

for (const scene of documentScenes.filter((entry) => filter.test(entry.id))) {
  it(scene.id, async () => {
    await measure(scene.id, scene.scenario, async (page, gateway, sample) => {
      // Full documents reload lazy chunks; use the route helper's readiness budget.
      page.setDefaultTimeout(60_000);
      await scene.visit(page, gateway, server.baseUrl);
      await sample(0);
      for (let cycle = 1; cycle <= 10; cycle++) {
        await scene.visit(page, gateway, server.baseUrl);
        if (cycle === 5 || cycle === 10) {
          await sample(cycle);
        }
      }
    });
  });
}

if (filter.test("session-switch")) {
  it("two blocks of 50 distinct session switches", async () => {
    const fixture = createInteractionFixture(build.buildId, build.version);
    fixture.sessions = fixture.sessions.slice(0, 100);
    fixture.sessionTranscripts = Object.fromEntries(
      fixture.sessions.map((session, index) => [
        session.key,
        {
          messages: [
            {
              role: "assistant",
              content: `Retention session ${index}`,
              timestamp: 1_800_000_000_000,
              __openclaw: { id: `retention-${index}`, seq: 1 },
            },
          ],
        },
      ]),
    );
    await measure("session-switch", fixture, async (page, _gateway, sample) => {
      await sample(0);
      for (let pass = 0; pass < 2; pass++) {
        for (const [index, session] of fixture.sessions.entries()) {
          if (Math.floor(index / 50) !== pass) {
            continue;
          }
          await navigateToControlUiSession(page, session.key);
          await page
            .locator(".chat-pane-cache__pane--active")
            .getByText(`Retention session ${index}`, { exact: true })
            .waitFor();
        }
        await navigate(page, "new-session", "/new");
        await sample((pass + 1) * 50);
      }
    });
  });
}

if (filter.test("stream")) {
  it("2,000 streamed deltas settle and retire", async () => {
    await measure("stream", baseScenario, async (page, gateway, sample) => {
      await navigateToControlUiSession(page, baseScenario.sessionKey!);
      const composer = page.locator(".chat-pane-cache__pane--active textarea").first();
      await composer.fill("Synthetic retention stream");
      await composer.press("Enter");
      const request = await gateway.waitForRequest("chat.send");
      if (!isRecord(request.params) || typeof request.params.idempotencyKey !== "string") {
        throw new Error("chat.send did not carry its run identity");
      }
      const runId = request.params.idempotencyKey;
      await sample(0);
      let text = "";
      for (let delta = 1; delta <= 2_000; delta++) {
        text += ` token${delta}`;
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey: baseScenario.sessionKey,
          state: "delta",
          deltaText: ` token${delta}`,
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
        if (delta % 500 === 0) {
          await page
            .locator(".chat-thread-inner")
            .getByText(new RegExp(`token${delta}`))
            .waitFor();
          await sample(delta);
        }
      }
      await gateway.emitChatFinal({
        runId,
        sessionKey: baseScenario.sessionKey,
        text: "Retention stream finalized",
      });
      await page
        .locator(".chat-thread-inner p")
        .filter({ hasText: /^Retention stream finalized$/u })
        .waitFor();
      await navigate(page, "new-session", "/new");
      await sample(2_001);
    });
  });
}

if (filter.test("reconnect")) {
  it("reconnect resources plateau over ten cycles", async () => {
    await measure("reconnect", baseScenario, async (page, gateway, sample) => {
      await navigateToControlUiSession(page, baseScenario.sessionKey!);
      await sample(0);
      for (let cycle = 1; cycle <= 10; cycle++) {
        const before = (await gateway.getRequests("connect")).length;
        await gateway.closeLatest(1012, "Synthetic retention reconnect");
        await gateway.waitForRequest("connect", { after: before });
        await page.waitForFunction(
          () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
        );
        if (cycle === 1 || cycle === 5 || cycle === 10) {
          await sample(cycle);
        }
      }
    });
  });
}

if (filter.test("dialog-mcp-confirmation")) {
  it("MCP App message confirmation releases its modal over ten cycles", async () => {
    const appModule = await readMcpAppModule();
    let document: ReturnType<typeof buildSandboxHostDocument>;
    const sandbox = createServer((request, response) => {
      if (request.url === "/app.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
        });
        response.end(appModule);
      } else if (request.url?.startsWith("/mcp-app-sandbox?")) {
        response.writeHead(200, document.headers);
        response.end(document.html);
      } else {
        response.writeHead(404).end();
      }
    });
    sandbox.listen(0, "127.0.0.1");
    await once(sandbox, "listening");
    try {
      const address = sandbox.address();
      if (!address || typeof address === "string") {
        throw new Error("MCP retention sandbox did not bind a TCP port");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const csp = { resourceDomains: [origin] };
      document = buildSandboxHostDocument(csp, [new URL(server.baseUrl).origin]);
      const viewId = "retention-mcp-view";
      await measure(
        "dialog-mcp-confirmation",
        {
          ...baseScenario,
          featureMethods: [...baseScenario.featureMethods!, "mcp.app.view", "mcp.app.callTool"],
          historyMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "canvas",
                  preview: {
                    kind: "canvas",
                    surface: "assistant_message",
                    render: "url",
                    title: "Retention MCP App",
                    viewId,
                    mcpApp: {
                      viewId,
                      originSessionKey: baseScenario.sessionKey,
                      serverName: "retention",
                      toolName: "preview",
                      uiResourceUri: "ui://retention/app.html",
                      toolCallId: "retention-tool-call",
                    },
                  },
                },
              ],
              timestamp: 1,
            },
          ],
          methodResponses: {
            ...baseScenario.methodResponses,
            "mcp.app.view": {
              sandboxUrl: buildSandboxHostPath(csp),
              sandboxPort: address.port,
              sandboxOrigin: origin,
              html: appHtml(`${origin}/app.js`),
              csp,
              toolInput: {},
              toolResult: { content: [] },
              messageSupported: true,
            },
            "mcp.app.callTool": { content: [], structuredContent: { value: "saved" } },
          },
        },
        async (page, _gateway, sample) => {
          await navigateToControlUiSession(page, baseScenario.sessionKey!);
          const app = await findAppFrame(page);
          await expect.poll(() => app.locator("#initialized").textContent()).toBe("ready");
          const visit = async () => {
            await app.locator("#send-message").click();
            const confirmation = page.getByRole("alertdialog");
            await confirmation.getByText("summarize selection", { exact: true }).waitFor();
            await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
            await confirmation.waitFor({ state: "detached" });
          };
          // The bridge admits ten prompts per minute. Warm the App itself;
          // the second block excludes the first modal's lazy-load cost.
          await sample(0);
          for (let cycle = 1; cycle <= 10; cycle++) {
            await visit();
            if (cycle === 5 || cycle === 10) {
              await sample(cycle);
            }
          }
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        sandbox.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}
