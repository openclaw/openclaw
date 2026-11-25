// Rotated same-document aging comparison with an independent identical-build control.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { expect } from "playwright/test";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiInitialRoster } from "../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  navigateToControlUiSession,
  waitForControlUiRoute,
  type MockGatewayControls,
  type MockGatewayWindow,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import { readWebKitAnimations } from "../ui/src/test-helpers/control-ui-webkit-animations.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { controlUiBenchOrder } from "./lib/control-ui-bench-order.ts";
import { createEngineActionTiming } from "./lib/control-ui-engine-action-timing.ts";
import { workingDayScenario } from "./lib/control-ui-engine-memory-scenarios.ts";
import { createEngineMemoryCollector } from "./lib/control-ui-engine-memory.ts";
import { startEngineMeasurement } from "./lib/control-ui-engine-metrics.ts";
import { frames, navigation } from "./lib/control-ui-interaction-navigation.ts";
import {
  createScenarioFixture,
  interactionScenarios,
  settingsSection,
} from "./lib/control-ui-interaction-scenarios.ts";
import {
  installControlUiResourceCounts,
  readControlUiResourceCounts,
} from "./lib/control-ui-resource-counts.ts";
import { launchTalkObservationBrowser } from "./lib/control-ui-talk-fixture.ts";

const { values } = parseArgs({
  options: {
    "base-bundle": { type: "string" },
    "head-bundle": { type: "string" },
    output: { type: "string", default: ".artifacts/aged-tab/compare" },
    "native-census": { type: "boolean", default: false },
    engines: { type: "string", default: "chromium,webkit" },
    samples: { type: "string", default: "20" },
    actions: { type: "string" },
    "ablate-scrollbar": { type: "boolean", default: false },
    "park-inactive-content": { type: "boolean", default: false },
    resources: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    heap: { type: "boolean", default: false },
  },
});
if (!values["base-bundle"] || !values["head-bundle"]) {
  throw new Error("Provide --base-bundle and --head-bundle");
}
if (!path.resolve(values.output).startsWith("/Volumes/Clawstudio-Storage/")) {
  throw new Error("Output must be on the external SSD");
}
const output = createControlUiE2eArtifactDir("three-arm", values.output);
const json = (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const samples = Number(values.samples);
const engines = values.engines.split(",").map((engine) => {
  if (engine !== "chromium" && engine !== "webkit" && engine !== "firefox") {
    throw new Error("Expected chromium, webkit or firefox");
  }
  return engine;
});
if (!Number.isInteger(samples) || samples < 1) {
  throw new Error("Expected positive samples");
}
const pane = ".chat-pane-cache__pane--active";
const text = "Synthetic typing 0123456789";
const rows: unknown[] = [];
const shared = (id: string) => {
  const found = interactionScenarios.find((s) => s.id === id);
  if (!found) {
    throw new Error("Missing scenario " + id);
  }
  return found;
};
const readBuild = async (directory: string) => {
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const raw = html.match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)?.[1];
  if (!raw) {
    throw new Error("Missing bundle identity: " + directory);
  }
  return normalizeControlUiBuildInfo(JSON.parse(raw));
};
const buildA = await readBuild(values["base-bundle"]),
  buildC = await readBuild(values["head-bundle"]);
await json("manifest.json", {
  started: new Date().toISOString(),
  samples,
  options: values,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  harnessSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  arms: {
    A: { bundle: values["base-bundle"], build: buildA },
    B: { bundle: values["base-bundle"], build: buildA },
    C: { bundle: values["head-bundle"], build: buildC },
  },
  contract: `Independent processes A/B identical base, C candidate; initial and aged n${samples} rotated triples. Each ages through 200 session navigations plus ten /new parks, one in-page batch per round. Native actions: ${values.actions ?? "typing,session-switch,route-switch,sidebar-toggle,model-picker"}. ${values.trace ? "Instrumented Timeline diagnostics" : "Untraced timing"}; native animation/heap enumeration only after timing. Chromium threadTicks; WebKit/Firefox application elapsed, no process CPU claim. No mock request array serialization inside measured actions.`,
  host: { platform: os.platform(), arch: os.arch(), load: os.loadavg() },
});
type Engine = "chromium" | "webkit" | "firefox";
type Arm = {
  name: "A" | "B" | "C";
  engine: Engine;
  page: Page;
  context: BrowserContext;
  browser: Browser;
  close: () => Promise<void>;
  server: Awaited<ReturnType<typeof startControlUiBenchGatewayServer>>;
  gateway: MockGatewayControls;
  baseline: ReturnType<typeof createScenarioFixture>;
  soak: ReturnType<typeof createScenarioFixture>;
  documentId: string;
  errors: string[];
};
async function openChat(arm: Arm) {
  await navigateToControlUiSession(arm.page, arm.baseline.sessions[0]!.key);
  const active = arm.page.locator(pane),
    last = active.getByText("Transcript 0 message 399.", { exact: false });
  const latest = active.locator('.chat-scroll-to-bottom[data-visible="true"]');
  await last.or(latest).first().waitFor();
  if (!(await last.isVisible())) {
    await latest.click();
  }
  await last.waitFor();
  await frames(arm.page);
}
async function closePicker(arm: Arm) {
  const picker = arm.page.locator(`${pane} .chat-controls__model-picker[open]`);
  if (await picker.count()) {
    await picker.locator("[data-chat-model-select]").click();
  }
  await picker.waitFor({ state: "detached" });
}
async function matchState(arm: Arm) {
  const expected = [
    arm.baseline.sessions[0]!.key,
    arm.baseline.sessions[1]!.key,
    arm.soak.sessions[1]!.key,
  ];
  const keys = await arm.page
    .locator(".chat-pane-cache__pane")
    .evaluateAll((ns) => ns.map((n) => Reflect.get(n, "sessionKey")));
  if (keys.length !== 3 || !expected.every((key) => keys.includes(key))) {
    for (const key of [expected[1]!, expected[2]!]) {
      await navigateToControlUiSession(arm.page, key);
      await arm.page
        .locator(pane + " textarea")
        .first()
        .waitFor();
    }
  }
  await openChat(arm);
  const pagination = arm.page.locator(
    ".sidebar-session-pagination:not(.sidebar-session-pagination--roster)",
  );
  await pagination.getByRole("button", { name: "Show more", exact: true }).first().click();
  await pagination.getByRole("button", { name: "Collapse", exact: true }).first().click();
  await arm.page.mouse.move(0, 0);
  await frames(arm.page);
  const state = await arm.page.evaluate(() => ({
    panes: [...document.querySelectorAll(".chat-pane-cache__pane")].map((n) => ({
      key: String(Reflect.get(n, "sessionKey")),
      nodes: n.querySelectorAll("*").length,
    })),
    rows: [...document.querySelectorAll(".sidebar-recent-session")].map((n) =>
      n.getAttribute("data-session-key"),
    ),
  }));
  if (
    state.panes.length !== 3 ||
    !expected.every((k) => state.panes.some((p) => p.key === k)) ||
    state.rows.length !== 15
  ) {
    throw new Error("Pane/sidebar state did not match");
  }
  return state;
}
const allActions = [
  {
    id: "typing",
    prepare: async (a: Arm) => {
      await openChat(a);
      await a.page
        .locator(pane + " textarea")
        .first()
        .fill("");
      await a.page
        .locator(pane + " textarea")
        .first()
        .focus();
    },
    run: async (a: Arm) => {
      await a.page.keyboard.type(text);
    },
  },
  {
    id: "session-switch",
    prepare: openChat,
    run: async (a: Arm) => {
      for (const index of [1, 0]) {
        const key = a.baseline.sessions[index]!.key;
        await navigation(a.page, "sessions");
        await a.page
          .locator(
            `.sidebar-recent-session[data-session-key="${key}"] .sidebar-recent-session__link`,
          )
          .click();
        await expect(a.page.locator(pane)).toHaveJSProperty("sessionKey", key);
        await expect(a.page.locator(pane)).toHaveJSProperty("transcriptReady", true);
        await a.page
          .locator(pane + " .chat-text:visible")
          .filter({ hasText: `Transcript ${index} message` })
          .first()
          .waitFor();
        await frames(a.page);
      }
    },
  },
  {
    id: "route-switch",
    prepare: async (a: Arm) => {
      await openChat(a);
      await a.page.keyboard.press("ControlOrMeta+Shift+,");
      await waitForControlUiRoute(a.page, { routeId: "appearance" });
      await shared("settings-sections").prepare(a.page, a.gateway);
    },
    run: async (a: Arm) => {
      await settingsSection(a.page, "/settings/notifications", "notifications");
      await settingsSection(a.page, "/settings/connection", "connection");
      await settingsSection(a.page, "/settings/appearance", "appearance");
      await frames(a.page);
    },
  },
  {
    id: "sidebar-toggle",
    prepare: openChat,
    run: async (a: Arm) => {
      await shared("sidebar-toggle").run(a.page, a.gateway);
    },
  },
  {
    id: "model-picker",
    prepare: async (a: Arm) => {
      await openChat(a);
      await closePicker(a);
      await a.page
        .locator(`${pane} [data-chat-model-select][aria-disabled="false"][aria-busy="false"]`)
        .waitFor();
    },
    run: async (a: Arm) => {
      await a.page.locator(pane + " [data-chat-model-select]").click();
      await a.page.locator(pane + " [data-chat-model-search]").pressSequentially("Warm model 0999");
      await a.page.locator(`${pane} [data-chat-model-option="example/model-999"]`).waitFor();
    },
  },
];
const selectedActions = values.actions?.split(",");
const actions = selectedActions
  ? allActions.filter((action) => selectedActions.includes(action.id))
  : allActions;
if (!actions.length || selectedActions?.some((id) => !actions.some((action) => action.id === id))) {
  throw new Error("Unknown action");
}
async function createArm(engine: Engine, name: Arm["name"]): Promise<Arm> {
  const bundle = name === "C" ? values["head-bundle"]! : values["base-bundle"]!,
    build = name === "C" ? buildC : buildA;
  const server = await startControlUiBenchGatewayServer(bundle);
  server.setTerminalEnabled(true);
  server.setFixtureReader((p) =>
    p === "/sw.js" ? { body: "", contentType: "text/javascript", status: 404 } : undefined,
  );
  let close: (() => Promise<void>) | undefined;
  try {
    const native = engine === "chromium" ? await launchTalkObservationBrowser(output, false) : null;
    const browser =
      native?.browser ??
      (await (engine === "firefox" ? firefox : webkit).launch({ headless: true }));
    const closeBrowser = native?.close ?? (() => browser.close());
    close = closeBrowser;
    const context =
      native?.context ??
      (await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: "light",
        serviceWorkers: "block",
      }));
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    page.setDefaultTimeout(30_000);
    await page.addInitScript("globalThis.__name = (fn) => fn");
    await page.addInitScript(() => Reflect.set(window, "__agedDocumentId", crypto.randomUUID()));
    if (values.resources) {
      await page.addInitScript(installControlUiResourceCounts);
    }
    await page.addInitScript(
      ({ key, url }) =>
        localStorage.setItem(key, JSON.stringify({ gatewayUrl: url, lobsterPetVisits: false })),
      {
        key: controlUiBundledSettingsStorageKey(server.baseUrl),
        url: controlUiBundledGatewayUrl(server.baseUrl),
      },
    );
    const baseline = createScenarioFixture(build.buildId, build.version!, shared("chat-typing"));
    const soak = createScenarioFixture(
      build.buildId,
      build.version!,
      workingDayScenario(10, "sessions"),
    );
    const fixture = {
      ...soak,
      models: baseline.models,
      sessions: [...baseline.sessions.slice(0, 2), ...soak.sessions].map((s, i) =>
        Object.assign({}, s, {
          kind: "direct" as const,
          updatedAt: 1_800_000_001_000 - i,
          owner: {
            actor: {
              type: "human" as const,
              id: "person-0",
              label: "Synthetic operator",
              identity: { type: "profile" as const, id: "person-0" },
            },
          },
        }),
      ),
      sessionTranscripts: { ...soak.sessionTranscripts, ...baseline.sessionTranscripts },
    };
    const list = createTeamScaleSidebarListOwner({
      rows: fixture.sessions,
      viewerProfileId: "person-0",
      now: 1_800_000_000_000,
      defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
      owners: [],
    });
    const gateway = await installMockGateway(
      page,
      { ...fixture, awaitInitialRoster: false },
      {
        requestHandlers: {
          "sessions.list": (params) => {
            if (!isRecord(params)) {
              throw new Error("Invalid list params");
            }
            return list.list(params).result;
          },
        },
      },
    );
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(server.baseUrl + "/new");
    await waitForControlUiInitialRoster(page, 30_000);
    if (name === "C" && values["ablate-scrollbar"]) {
      const removed = await page.evaluate(() => {
        let count = 0;
        for (const sheet of document.styleSheets) {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSStyleRule && rule.selectorText === "::-webkit-scrollbar") {
              rule.style.removeProperty("width");
              rule.style.removeProperty("height");
              count++;
            }
          }
        }
        return count;
      });
      if (removed !== 1) {
        throw new Error(`Expected one scrollbar dimension rule, found ${removed}`);
      }
    }
    if (name === "C" && values["park-inactive-content"]) {
      await page.addStyleTag({
        content:
          ".chat-pane-cache__pane:not(.chat-pane-cache__pane--visible) { content-visibility: hidden; }",
      });
    }
    const arm: Arm = {
      name,
      engine,
      page,
      context,
      browser,
      close: closeBrowser,
      server,
      gateway,
      baseline,
      soak,
      errors,
      documentId: await page.evaluate(() => String(Reflect.get(window, "__agedDocumentId"))),
    };
    for (const action of allActions) {
      await action.prepare(arm);
      await action.run(arm);
    }
    await closePicker(arm);
    await matchState(arm);
    return arm;
  } catch (error) {
    await close?.();
    await server.close();
    throw error;
  }
}
async function sample(arm: Arm, stage: string, index: number, action: (typeof actions)[number]) {
  await arm.page.bringToFront();
  if (action.id !== "route-switch") {
    await matchState(arm);
  }
  await action.prepare(arm);
  const requestMethod =
    action.id === "typing"
      ? "chat.send"
      : action.id === "route-switch"
        ? "config.schema"
        : undefined;
  const requestCount = () =>
    arm.page.evaluate(
      (method) =>
        (window as MockGatewayWindow).openclawControlUiE2eGateway!.requests.reduce(
          (n, r) => n + Number(r.method === method),
          0,
        ),
      requestMethod,
    );
  const beforeRequests = requestMethod ? await requestCount() : undefined;
  const beforeResources = values.resources
    ? await readControlUiResourceCounts(arm.page)
    : undefined;
  const timing = await arm.page.evaluateHandle(createEngineActionTiming, false);
  await timing.evaluate((t) => t.start());
  const measurement = await startEngineMeasurement(arm.page, arm.engine, { trace: values.trace });
  const start = performance.now();
  await action.run(arm);
  const actionWallMs = performance.now() - start;
  const measured = await measurement.stop();
  await timing.evaluate((t) => t.endScenario());
  const observed = await timing.evaluate((t) => t.finish());
  await timing.dispose();
  if (values.trace) {
    await json(`${arm.engine}-${arm.name}-${stage}-${action.id}-${index}-trace.json`, measured);
  }
  if (action.id === "typing") {
    await expect(arm.page.locator(pane + " textarea").first()).toHaveValue(text);
  }
  if (requestMethod && (await requestCount()) !== beforeRequests) {
    throw new Error(`${action.id} sent an unexpected ${requestMethod} request`);
  }
  if (action.id === "model-picker") {
    await expect(arm.page.locator(pane + " [data-chat-model-option]:visible")).toHaveCount(1);
    await closePicker(arm);
  }
  if (arm.errors.length) {
    throw new Error(arm.errors.join("\n"));
  }
  if (
    (await arm.page.evaluate(() => String(Reflect.get(window, "__agedDocumentId")))) !==
    arm.documentId
  ) {
    throw new Error("Document reloaded");
  }
  rows.push({
    engine: arm.engine,
    arm: arm.name,
    stage,
    index,
    action: action.id,
    timing: observed,
    actionWallMs,
    metrics: measured.metrics,
    resources: values.resources
      ? { before: beforeResources, after: await readControlUiResourceCounts(arm.page) }
      : undefined,
    load: os.loadavg(),
  });
  await json("observations.json", rows);
}
async function checkpoint(arms: Arm[], stage: string) {
  console.log(JSON.stringify({ engine: arms[0]!.engine, stage }));
  const states: Array<{ arm: Arm["name"]; state: Awaited<ReturnType<typeof matchState>> }> = [];
  for (const arm of arms) {
    await matchState(arm);
    // Churn evicts the probe pane. Match its previously used lazy picker as well
    // as session keys before comparing an initial and retained document.
    const picker = allActions.find((action) => action.id === "model-picker")!;
    await picker.prepare(arm);
    await picker.run(arm);
    await closePicker(arm);
    states.push({ arm: arm.name, state: await matchState(arm) });
  }
  await json(`${arms[0]!.engine}-${stage}-state.json`, states);
  if (states.some((s) => JSON.stringify(s.state.rows) !== JSON.stringify(states[0]!.state.rows))) {
    throw new Error("Sidebar row identities differ across arms");
  }
  const panes = (state: Awaited<ReturnType<typeof matchState>>) =>
    state.panes.toSorted((a, b) => a.key.localeCompare(b.key));
  if (
    states.some((s) => JSON.stringify(panes(s.state)) !== JSON.stringify(panes(states[0]!.state)))
  ) {
    for (const arm of arms) {
      await arm.page.screenshot({
        path: path.join(output, `${arm.engine}-${arm.name}-mismatch.png`),
      });
    }
    throw new Error("Retained pane contents differ across arms");
  }
  for (const arm of arms) {
    await json(`${arm.engine}-${arm.name}-${stage}-census.json`, {
      resources: values.resources ? await readControlUiResourceCounts(arm.page) : undefined,
      structure: await arm.page.evaluate(() => {
        const rules = (list: CSSRuleList): number =>
          [...list].reduce(
            (n, rule) => n + 1 + (rule instanceof CSSGroupingRule ? rules(rule.cssRules) : 0),
            0,
          );
        const classes: Record<string, number> = {};
        for (const node of document.querySelectorAll(".chat-pane-cache__pane *")) {
          const key = `${node.tagName}.${node.getAttribute("class") ?? ""}`;
          classes[key] = (classes[key] ?? 0) + 1;
        }
        return {
          nodes: document.querySelectorAll("*").length,
          renderedPaneDescendants: [
            ...document.querySelectorAll(".chat-pane-cache__pane *"),
          ].filter((node) => node.checkVisibility()).length,
          sheets: document.styleSheets.length,
          rules: [...document.styleSheets].reduce((n, sheet) => n + rules(sheet.cssRules), 0),
          paneClasses: classes,
        };
      }),
    });
  }
  for (const action of actions) {
    for (let index = 0; index < samples; index++) {
      for (const arm of controlUiBenchOrder(arms, index)) {
        await sample(arm, stage, index, action);
      }
    }
  }
}
async function age(arm: Arm) {
  console.log(JSON.stringify({ engine: arm.engine, arm: arm.name, stage: "churn" }));
  const started = performance.now();
  const checkpoints: string[] = [];
  await workingDayScenario(10, "sessions-in-page").run(arm.page, arm.gateway, async (label) => {
    checkpoints.push(label);
  });
  if (checkpoints.length !== 10) {
    throw new Error("Incomplete session churn");
  }
  await json(`${arm.engine}-${arm.name}-churn.json`, {
    switches: 200,
    parks: checkpoints.length,
    elapsedMs: performance.now() - started,
    checkpoints,
  });
}
async function captureMemory(arm: Arm, label: string) {
  const file = path.join(output, `${arm.engine}-${label}.heapsnapshot`);
  const collector = await createEngineMemoryCollector(arm.page, arm.engine);
  try {
    await json(`${arm.engine}-${label}-memory.json`, await collector.capture(file));
  } finally {
    await collector.dispose();
    await unlink(file).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}
for (const engine of engines) {
  const arms: Arm[] = [];
  try {
    for (const name of ["A", "B", "C"] as const) {
      arms.push(await createArm(engine, name));
    }
    await checkpoint(arms, "initial");
    for (const arm of controlUiBenchOrder(arms, engine === "chromium" ? 0 : 1)) {
      await age(arm);
    }
    await checkpoint(arms, "aged");
    if (engine === "webkit" && values["native-census"]) {
      for (const arm of arms) {
        await json(
          `webkit-${arm.name}-native-animations.json`,
          await readWebKitAnimations(arm.page),
        );
      }
    }
    if (values.heap && engine !== "firefox") {
      // Forced GC and native wrapper inspection run only after all timing.
      for (const arm of arms) {
        await captureMemory(arm, `${arm.name}-aged`);
      }
      const fresh = await createArm(engine, "A");
      try {
        const picker = allActions.find((action) => action.id === "model-picker")!;
        await picker.prepare(fresh);
        await picker.run(fresh);
        await closePicker(fresh);
        await matchState(fresh);
        await captureMemory(fresh, "fresh");
      } finally {
        await fresh.close();
        await fresh.server.close();
      }
    }
    for (const arm of arms) {
      await openChat(arm);
      await arm.page.screenshot({ path: path.join(output, `${engine}-${arm.name}.png`) });
      await json(
        `${engine}-${arm.name}-styles.json`,
        await arm.page.evaluate(() => {
          const selectors = [
            ".app-shell",
            ".chat-pane-cache__pane--active",
            ".chat-textarea",
            ".chat-controls__model-picker",
            ".sidebar-region",
            ".loading-skeleton",
          ];
          return selectors.map((selector) => ({
            selector,
            elements: [...document.querySelectorAll(selector)].map((element) => {
              const style = getComputedStyle(element);
              return Object.fromEntries(
                [
                  "display",
                  "position",
                  "width",
                  "height",
                  "font",
                  "color",
                  "backgroundColor",
                  "padding",
                  "margin",
                  "animationName",
                  "transitionProperty",
                ].map((key) => [key, Reflect.get(style, key)]),
              );
            }),
          }));
        }),
      );
    }
  } finally {
    for (const arm of arms.toReversed()) {
      await arm.close();
      await arm.server.close();
    }
  }
}
console.log(JSON.stringify({ complete: true, output }));
