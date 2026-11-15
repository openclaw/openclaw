// Same-document latency census. Synthetic transport isolates renderer aging from Gateway load.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { webkit, type Browser, type BrowserContext, type JSHandle, type Page } from "playwright";
import { expect } from "playwright/test";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "../ui/src/components/app-sidebar-session-types.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { waitForControlUiInitialRoster } from "../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  navigateToControlUiSession,
  waitForControlUiRoute,
  type MockGatewayControls,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { controlUiBenchOrder } from "./lib/control-ui-bench-order.ts";
import { createEngineActionTiming } from "./lib/control-ui-engine-action-timing.ts";
import { workingDayScenario } from "./lib/control-ui-engine-memory-scenarios.ts";
import { createEngineMemoryCollector } from "./lib/control-ui-engine-memory.ts";
import { startEngineMeasurement, type ControlUiEngine } from "./lib/control-ui-engine-metrics.ts";
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
import { summarizeRetentionHeap } from "./lib/control-ui-retention.ts";
import { launchTalkObservationBrowser } from "./lib/control-ui-talk-fixture.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    output: { type: "string", default: ".artifacts/aged-tab/run" },
    engines: { type: "string", default: "chromium,webkit" },
    samples: { type: "string", default: "20" },
    rounds: { type: "string", default: "10" },
    "idle-minutes": { type: "string", default: "120" },
    trace: { type: "boolean", default: false },
    heap: { type: "boolean", default: false },
    "in-page": { type: "boolean", default: false },
    "match-sidebar": { type: "boolean", default: false },
    "match-styles": { type: "boolean", default: false },
    soak: { type: "string", default: "all" },
  },
});
const samples = Number(values.samples);
const rounds = Number(values.rounds);
const idleMinutes = Number(values["idle-minutes"]);
if (
  !Number.isInteger(samples) ||
  samples < 1 ||
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  rounds > 10 ||
  !Number.isFinite(idleMinutes) ||
  idleMinutes < 0
) {
  throw new Error("Expected positive samples, 1–10 rounds and nonnegative idle minutes");
}
const engines = values.engines.split(",").map((engine) => {
  if (engine !== "chromium" && engine !== "webkit") {
    throw new Error("Expected chromium and/or webkit");
  }
  return engine;
});
const output = createControlUiE2eArtifactDir("aged-tab", values.output);
const json = (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const html = await readFile(path.join(values["bundle-dir"], "index.html"), "utf8");
const raw = html.match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)?.[1];
if (!raw) {
  throw new Error("Missing production build identity");
}
const build = normalizeControlUiBuildInfo(JSON.parse(raw));
const soakMode = values.soak;
if (
  soakMode !== "all" &&
  soakMode !== "sessions" &&
  soakMode !== "sessions-in-page" &&
  soakMode !== "turns" &&
  soakMode !== "routes" &&
  soakMode !== "reconnects" &&
  soakMode !== "overlays"
) {
  throw new Error(
    "Expected --soak all, sessions, sessions-in-page, turns, routes, reconnects or overlays",
  );
}
const soak = workingDayScenario(rounds, soakMode);
const typing = interactionScenarios.find(({ id }) => id === "chat-typing")!;
const typingText = "Synthetic typing 0123456789";
const baseline = createScenarioFixture(build.buildId, build.version!, typing);
const soakFixture = createScenarioFixture(build.buildId, build.version!, soak);
// Keep the measured transcripts fixed while the independent soak sessions accumulate turns.
const fixture = {
  ...soakFixture,
  models: baseline.models,
  sessions: [...baseline.sessions.slice(0, 2), ...soakFixture.sessions].map((session, index) =>
    Object.assign({}, session, {
      kind: "direct" as const,
      updatedAt: 1_800_000_001_000 - index,
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
  sessionTranscripts: { ...soakFixture.sessionTranscripts, ...baseline.sessionTranscripts },
};
const sessionKey = baseline.sessions[0]!.key;
const server = await startControlUiBenchGatewayServer(values["bundle-dir"]);
server.setTerminalEnabled(true);
// Like the shared engine harness, exclude service-worker transport/update behavior.
// The native visibility context cannot select Playwright's serviceWorkers option.
server.setFixtureReader((pathname) =>
  pathname === "/sw.js" ? { body: "", contentType: "text/javascript", status: 404 } : undefined,
);
const observations: unknown[] = [];
const checkpoints: unknown[] = [];
const started = Date.now();
await json("manifest.json", {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  harnessSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  build,
  started: new Date(started).toISOString(),
  samples,
  rounds,
  idleMinutes,
  trace: values.trace,
  heap: values.heap,
  inPage: values["in-page"],
  matchSidebar: values["match-sidebar"],
  matchStyles: values["match-styles"],
  soak: soakMode,
  host: { platform: os.platform(), arch: os.arch(), load: os.loadavg() },
  contract: `${samples} rotated fresh/control/aged samples; flag >10% median age change beyond fresh A/A; trace runs separate. Same synthetic transport, fixed 400-message probes, 202 sidebar sessions, working-day churn; no forced GC before timing. Idle first input reported separately from its warmed samples.`,
});
const pane = ".chat-pane-cache__pane--active";
async function openChat(page: Page) {
  await navigateToControlUiSession(page, sessionKey);
  const active = page.locator(pane);
  const last = active.getByText("Transcript 0 message 399.", { exact: false });
  const latest = active.locator('.chat-scroll-to-bottom[data-visible="true"]');
  // Restore the common probe position outside timing, as in memory-long-session.
  await last.or(latest).first().waitFor();
  if (!(await last.isVisible())) {
    await latest.click();
  }
  await last.waitFor();
  await frames(page);
}
async function census(page: Page) {
  return {
    resources: await readControlUiResourceCounts(page),
    structure: await page.evaluate(() => {
      const sheets = [...document.styleSheets, ...document.adoptedStyleSheets];
      const countRules = (rules: CSSRuleList): number => {
        let count = rules.length;
        for (const rule of rules) {
          if ("cssRules" in rule) {
            // SAFETY: Native rules exposing cssRules implement the grouping-rule contract.
            count += countRules((rule as CSSGroupingRule).cssRules);
          }
        }
        return count;
      };
      const active = document.querySelector(".chat-pane-cache__pane--active");
      const style = active ? getComputedStyle(active) : null;
      return {
        documentId: Reflect.get(window, "__agedDocumentId"),
        timeOrigin: performance.timeOrigin,
        ageMs: performance.now(),
        visibility: document.visibilityState,
        visibilityChanges: Reflect.get(window, "__agedVisibility"),
        domNodes: document.querySelectorAll("*").length,
        panes: document.querySelectorAll(".chat-pane-cache__pane").length,
        paneKeys: [...document.querySelectorAll(".chat-pane-cache__pane")].map((node) =>
          Reflect.get(node, "sessionKey"),
        ),
        sidebarRowKeys: [...document.querySelectorAll(".sidebar-recent-session")].map((node) =>
          node.getAttribute("data-session-key"),
        ),
        animations: document.getAnimations().map((animation) => {
          const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null;
          const target = effect?.target;
          return {
            type: animation.constructor.name,
            name: animation instanceof CSSAnimation ? animation.animationName : null,
            property: animation instanceof CSSTransition ? animation.transitionProperty : null,
            playState: animation.playState,
            pseudoElement: effect?.pseudoElement,
            target: target instanceof Element ? target.getAttribute("class") : null,
          };
        }),
        stylesheets: sheets.length,
        stylesheetHrefs: sheets.map((sheet) => sheet.href),
        rules: sheets.reduce((count, sheet) => count + countRules(sheet.cssRules), 0),
        computed: style
          ? {
              display: style.display,
              color: style.color,
              background: style.backgroundColor,
              font: style.font,
              width: style.width,
              height: style.height,
            }
          : null,
      };
    }),
  };
}
type Tab = Awaited<ReturnType<typeof createTab>>;
async function matchPaneCache(page: Page) {
  const keys = [sessionKey, baseline.sessions[1]!.key, soakFixture.sessions[1]!.key];
  const retained = await page
    .locator(".chat-pane-cache__pane")
    .evaluateAll((nodes) => nodes.map((node) => Reflect.get(node, "sessionKey")));
  if (retained.length === keys.length && keys.every((key) => retained.includes(key))) {
    return;
  }
  for (const key of keys.slice(1)) {
    await navigateToControlUiSession(page, key);
    await page.locator(`${pane} textarea`).first().waitFor();
  }
  await openChat(page);
  await expect
    .poll(() =>
      page
        .locator(".chat-pane-cache__pane")
        .evaluateAll((nodes) =>
          nodes
            .map((node) => String(Reflect.get(node, "sessionKey")))
            .toSorted((left, right) => left.localeCompare(right)),
        ),
    )
    .toEqual(keys.toSorted((left, right) => left.localeCompare(right)));
}

async function matchSidebar(page: Page) {
  const pagination = page.locator(
    ".sidebar-session-pagination:not(.sidebar-session-pagination--roster)",
  );
  // Lowering the limit clears the deliberately retained prior page; Collapse at
  // the default limit alone leaves that history intact.
  await pagination.getByRole("button", { name: "Show more", exact: true }).first().click();
  await pagination.getByRole("button", { name: "Collapse", exact: true }).first().click();
  await page.locator(".sidebar-shell__body").evaluate((node) => node.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await frames(page);
  await expect
    .poll(() =>
      page
        .locator(".sidebar-recent-session")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session-key"))),
    )
    .toEqual(fixture.sessions.slice(0, SIDEBAR_SESSION_PAGE_SIZE).map((session) => session.key));
}

async function matchStyles(aged: Page, control: Page) {
  const hrefs = await aged.evaluate(() =>
    [...document.styleSheets].flatMap((sheet) => (sheet.href ? [sheet.href] : [])),
  );
  await control.evaluate(async (stylesheetUrls) => {
    const resident = new Set([...document.styleSheets].map((sheet) => sheet.href));
    for (const href of stylesheetUrls) {
      if (resident.has(href)) {
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.addEventListener("load", () => resolve(), { once: true });
        link.addEventListener(
          "error",
          () => reject(new Error(`Could not match stylesheet: ${href}`)),
          { once: true },
        );
        document.head.append(link);
      });
    }
  }, hrefs);
  await frames(control);
}

async function createTab(browser: Browser, nativeContext?: BrowserContext) {
  const context =
    nativeContext ??
    (await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "light",
      serviceWorkers: "block",
    }));
  const page = await context.newPage();
  await page.bringToFront();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  page.setDefaultTimeout(30_000);
  await page.addInitScript("globalThis.__name = (fn) => fn");
  await page.addInitScript(installControlUiResourceCounts);
  await page.addInitScript(() => {
    Reflect.set(window, "__agedDocumentId", crypto.randomUUID());
    const changes = [{ at: performance.now(), state: document.visibilityState }];
    document.addEventListener("visibilitychange", () => {
      changes.push({ at: performance.now(), state: document.visibilityState });
      if (changes.length > 32) {
        changes.shift();
      }
    });
    Reflect.set(window, "__agedVisibility", changes);
  });
  await page.addInitScript(
    ({ key, gatewayUrl }) => {
      localStorage.setItem(key, JSON.stringify({ gatewayUrl, lobsterPetVisits: false }));
    },
    {
      key: controlUiBundledSettingsStorageKey(server.baseUrl),
      gatewayUrl: controlUiBundledGatewayUrl(server.baseUrl),
    },
  );
  const sessions = createTeamScaleSidebarListOwner({
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
            throw new Error("Expected sessions.list parameters");
          }
          return sessions.list(params).result;
        },
      },
    },
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${server.baseUrl}/new`);
  try {
    await waitForControlUiInitialRoster(page, 30_000);
  } catch (error) {
    console.error(
      JSON.stringify({
        setup: "initial-roster",
        errors,
        visibility: await page.evaluate(() => document.visibilityState),
      }),
    );
    await page.screenshot({ path: path.join(output, "initial-roster-failure.png") });
    throw error;
  }
  await openChat(page);
  // Warm each action and both retained probe panes equally in all tabs.
  for (const action of actions) {
    console.log(
      JSON.stringify({ phase: "warm", action: action.id, browser: browser.browserType().name() }),
    );
    await action.prepare(page, gateway);
    await action.run(page, gateway);
  }
  await closeModelPicker(page);
  await openChat(page);
  await matchPaneCache(page);
  return {
    context,
    page,
    gateway,
    errors,
    documentId: await page.evaluate(() => String(Reflect.get(window, "__agedDocumentId"))),
  };
}
const shared = (id: string) => {
  const found = interactionScenarios.find((scenario) => scenario.id === id);
  if (!found) {
    throw new Error(`Missing shared action ${id}`);
  }
  return found;
};
async function closeModelPicker(page: Page) {
  const open = page.locator(`${pane} .chat-controls__model-picker[open]`);
  if (await open.count()) {
    await open.locator("[data-chat-model-select]").click();
  }
  await open.waitFor({ state: "detached" });
  const search = page.locator(`${pane} [data-chat-model-search]`);
  if (await search.count()) {
    await expect(search).toHaveValue("");
  }
}
const actions = [
  {
    id: "typing",
    prepare: async (page: Page) => {
      await openChat(page);
      await page.locator(`${pane} textarea`).first().fill("");
    },
    run: async (page: Page) => {
      await page.keyboard.type(typingText);
      await frames(page);
    },
  },
  {
    id: "session-switch",
    prepare: openChat,
    run: async (page: Page) => {
      for (const index of [1, 0]) {
        const key = baseline.sessions[index]!.key;
        await navigation(page, "sessions");
        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${key}"] .sidebar-recent-session__link`,
          )
          .click();
        const active = page.locator(pane);
        await expect(active).toHaveJSProperty("sessionKey", key);
        await expect(active).toHaveJSProperty("transcriptReady", true);
        await active
          .locator(".chat-text:visible")
          .filter({ hasText: `Transcript ${index} message` })
          .first()
          .waitFor();
        await frames(page);
      }
    },
  },
  {
    id: "route-switch",
    prepare: async (page: Page, gateway: MockGatewayControls) => {
      await openChat(page);
      await page.keyboard.press("ControlOrMeta+Shift+,");
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await shared("settings-sections").prepare(page, gateway);
    },
    run: async (page: Page) => {
      await settingsSection(page, "/settings/notifications", "notifications");
      await settingsSection(page, "/settings/connection", "connection");
      await settingsSection(page, "/settings/appearance", "appearance");
      await frames(page);
    },
  },
  { id: "sidebar-toggle", prepare: openChat, run: shared("sidebar-toggle").run },
  {
    id: "model-picker",
    prepare: async (page: Page) => {
      await openChat(page);
      await closeModelPicker(page);
      await page
        .locator(`${pane} [data-chat-model-select][aria-disabled="false"][aria-busy="false"]`)
        .waitFor();
    },
    run: async (page: Page) => {
      await page.locator(`${pane} [data-chat-model-select]`).click();
      await page.locator(`${pane} [data-chat-model-search]`).pressSequentially("Warm model 0999");
      await page.locator(`${pane} [data-chat-model-option="example/model-999"]`).waitFor();
      await expect(page.locator(`${pane} [data-chat-model-option]:visible`)).toHaveCount(1);
    },
  },
];
async function countRequests(page: Page, method: string) {
  return page.evaluate(
    (requestMethod) =>
      (window as MockGatewayWindow).openclawControlUiE2eGateway!.requests.reduce(
        (count, request) => count + Number(request.method === requestMethod),
        0,
      ),
    method,
  );
}

async function sample(
  tab: Tab,
  engine: ControlUiEngine,
  stage: string,
  role: string,
  index: number,
  action: (typeof actions)[number],
) {
  await tab.page.bringToFront();
  await action.prepare(tab.page, tab.gateway);
  if (action.id !== "route-switch") {
    await matchPaneCache(tab.page);
    if (values["match-sidebar"]) {
      await matchSidebar(tab.page);
    }
  }
  if (action.id === "typing") {
    await tab.page.locator(`${pane} textarea`).first().focus();
  }
  const sends = action.id === "typing" ? await countRequests(tab.page, "chat.send") : undefined;
  const schemas =
    action.id === "route-switch" ? await countRequests(tab.page, "config.schema") : undefined;
  const timing = await tab.page.evaluateHandle(createEngineActionTiming, false);
  const measurement =
    values.trace || engine === "chromium"
      ? await startEngineMeasurement(tab.page, engine, { trace: values.trace })
      : undefined;
  await timing.evaluate((value) => value.start());
  const start = performance.now();
  try {
    await action.run(tab.page, tab.gateway);
  } catch (error) {
    const prefix = `${engine}-${stage}-${role}-${index}-${action.id}-failure`;
    await tab.page.screenshot({ path: path.join(output, `${prefix}.png`) });
    await json(`${prefix}.json`, {
      error: String(error),
      requests: (await tab.gateway.getRequests()).slice(-20),
      controls: await tab.page
        .locator(`${pane} [data-chat-model-select]`)
        .evaluateAll((controls) => controls.map((control) => control.outerHTML)),
      errors: tab.errors,
    });
    throw error;
  }
  const wallMs = performance.now() - start;
  await timing.evaluate((value) => value.endScenario());
  const result = await timing.evaluate((value) => value.finish());
  await timing.dispose();
  const metrics = await measurement?.stop();
  if (action.id === "typing") {
    await expect(tab.page.locator(`${pane} textarea`).first()).toHaveValue(typingText);
    if ((await countRequests(tab.page, "chat.send")) !== sends) {
      throw new Error("Typing must not send a chat request");
    }
  }
  if (schemas !== undefined && (await countRequests(tab.page, "config.schema")) !== schemas) {
    throw new Error("Warm Settings tabs must retain the loaded config schema");
  }
  const stylePasses: Array<{ elements: number | null }> = [];
  const visit = (entry: unknown) => {
    if (!isRecord(entry)) {
      return;
    }
    if (entry.name === "UpdateLayoutTree" || entry.type === "RecalculateStyles") {
      stylePasses.push({
        elements:
          isRecord(entry.args) && typeof entry.args.elementCount === "number"
            ? entry.args.elementCount
            : null,
      });
    }
    if (Array.isArray(entry.children)) {
      entry.children.forEach(visit);
    }
  };
  metrics?.timeline?.forEach(visit);
  const row = {
    engine,
    stage,
    role,
    index,
    action: action.id,
    wallMs,
    timing: result,
    metrics: metrics?.metrics,
    stylePasses,
    load: os.loadavg(),
  };
  observations.push(row);
  await json("observations.json", observations);
  if (action.id === "model-picker") {
    await closeModelPicker(tab.page);
  }
  await assertDocument(tab, `${engine}-${stage}-${role}-${index}-${action.id}-reload`);
  return row;
}

async function assertDocument(tab: Tab, prefix: string) {
  if (tab.errors.length) {
    throw new Error(tab.errors.join("\n"));
  }
  const documentId = await tab.page.evaluate(() => String(Reflect.get(window, "__agedDocumentId")));
  if (documentId !== tab.documentId) {
    await tab.page.screenshot({ path: path.join(output, `${prefix}.png`) });
    await json(`${prefix}.json`, {
      expectedDocumentId: tab.documentId,
      documentId,
      ...(await census(tab.page)),
      errors: tab.errors,
    });
    throw new Error("Measured tab reloaded");
  }
}

async function inPageSample(
  tab: Tab,
  engine: ControlUiEngine,
  stage: string,
  role: string,
  index: number,
  action: (typeof actions)[number],
) {
  await tab.page.bringToFront();
  await action.prepare(tab.page, tab.gateway);
  if (action.id !== "route-switch") {
    await matchPaneCache(tab.page);
    if (values["match-sidebar"]) {
      await matchSidebar(tab.page);
    }
  }
  const sends = action.id === "typing" ? await countRequests(tab.page, "chat.send") : undefined;
  const schemas =
    action.id === "route-switch" ? await countRequests(tab.page, "config.schema") : undefined;
  const measurement =
    values.trace || engine === "chromium"
      ? await startEngineMeasurement(tab.page, engine, { trace: values.trace })
      : undefined;
  const result = await tab.page.evaluate(
    async ({ id, keys }) => {
      const active = ".chat-pane-cache__pane--active";
      const phases: Array<{ syncMs: number; secondFrameMs: number; settledMs: number }> = [];
      const frame = () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      const element = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector);
        if (!node) {
          throw new Error(`Missing in-page target: ${selector}`);
        }
        return node;
      };
      const invoke = async (run: () => void, ready: () => boolean = () => true) => {
        const start = performance.now();
        run();
        const syncMs = performance.now() - start;
        await frame();
        await frame();
        const secondFrameMs = performance.now() - start;
        const deadline = performance.now() + 5_000;
        while (!ready()) {
          if (performance.now() > deadline) {
            throw new Error(`In-page action did not settle: ${id}`);
          }
          await frame();
        }
        phases.push({ syncMs, secondFrameMs, settledMs: performance.now() - start });
      };
      const click = (selector: string) => {
        const node = element(selector);
        node.focus();
        node.click();
      };
      const input = (selector: string, value: string) => {
        const node = element(selector);
        if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
          throw new Error(`Expected text input: ${selector}`);
        }
        node.focus();
        node.value = value;
        node.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
        );
      };
      const routeReady = (pathname: string) => {
        const state = window.openclawControlUi!.snapshot();
        return (
          location.pathname === pathname &&
          state.routeReady &&
          state.route?.status === "success" &&
          state.route.pendingMatches.length === 0 &&
          state.route.resolvedLocation?.pathname === pathname
        );
      };
      if (id === "typing") {
        let value = "";
        for (const char of "Synthetic typing 0123456789") {
          value += char;
          await invoke(() => input(`${active} textarea`, value));
        }
      } else if (id === "session-switch") {
        for (const key of [keys[1]!, keys[0]!]) {
          const selector = `.sidebar-recent-session[data-session-key="${CSS.escape(key)}"] .sidebar-recent-session__link`;
          const pathname = new URL(element(selector).getAttribute("href")!, location.href).pathname;
          await invoke(
            () => click(selector),
            () =>
              routeReady(pathname) &&
              window.openclawControlUi!.snapshot().sessionKey === key &&
              Reflect.get(element(active), "sessionKey") === key &&
              Reflect.get(element(active), "transcriptReady") === true &&
              [...document.querySelectorAll(`${active} .chat-text`)].some(
                (node) =>
                  node.getClientRects().length > 0 &&
                  node.textContent?.includes(`Transcript ${keys.indexOf(key)} message`),
              ),
          );
        }
      } else if (id === "route-switch") {
        for (const pathname of [
          "/settings/notifications",
          "/settings/connection",
          "/settings/appearance",
        ]) {
          await invoke(
            () => click(`.settings-sidebar a[href="${pathname}"]`),
            () => routeReady(pathname),
          );
        }
      } else if (id === "sidebar-toggle") {
        await invoke(() => click(".sidebar-session-toolbar__collapse"));
        await invoke(
          () => click('[data-navigation-view="sessions"]'),
          () =>
            Boolean(
              document
                .querySelector(
                  `.sidebar-recent-session[data-session-key="${CSS.escape(keys[0]!)}"]`,
                )
                ?.getClientRects().length,
            ),
        );
      } else if (id === "model-picker") {
        await invoke(
          () => click(`${active} [data-chat-model-select]`),
          () =>
            Boolean(
              document.querySelector(`${active} [data-chat-model-search]`)?.getClientRects().length,
            ),
        );
        await invoke(
          () => input(`${active} [data-chat-model-search]`, "Warm model 0999"),
          () =>
            document.querySelectorAll(`${active} [data-chat-model-option]`).length === 1 &&
            Boolean(
              document
                .querySelector(`${active} [data-chat-model-option="example/model-999"]`)
                ?.getClientRects().length,
            ),
        );
      }
      return {
        phases,
        syncMs: phases.reduce((sum, phase) => sum + phase.syncMs, 0),
        settledMs: phases.reduce((sum, phase) => sum + phase.settledMs, 0),
      };
    },
    { id: action.id, keys: baseline.sessions.slice(0, 2).map((session) => session.key) },
  );
  const metrics = await measurement?.stop();
  if (action.id === "typing") {
    await expect(tab.page.locator(`${pane} textarea`).first()).toHaveValue(
      "Synthetic typing 0123456789",
    );
    if ((await countRequests(tab.page, "chat.send")) !== sends) {
      throw new Error("In-page typing must not send a chat request");
    }
  }
  if (schemas !== undefined && (await countRequests(tab.page, "config.schema")) !== schemas) {
    throw new Error("Warm Settings tabs must retain the loaded config schema");
  }
  observations.push({
    engine,
    stage,
    role,
    index,
    action: action.id,
    delivery: "in-page",
    result,
    metrics: metrics?.metrics,
    timeline: metrics?.timeline,
    load: os.loadavg(),
  });
  await json("observations.json", observations);
  if (action.id === "model-picker") {
    await closeModelPicker(tab.page);
  }
  await assertDocument(tab, `${engine}-${stage}-${role}-${index}-${action.id}-reload`);
}

async function launch(engine: ControlUiEngine) {
  if (engine === "chromium") {
    return launchTalkObservationBrowser(output, false);
  }
  const browser = await webkit.launch({ headless: true });
  return { browser, context: undefined, close: () => browser.close() };
}

async function checkpoint(tab: Tab, engine: ControlUiEngine, stage: string) {
  console.log(JSON.stringify({ engine, stage, phase: "start", load: os.loadavg() }));
  // Browser-process history must not be shared with either fresh control.
  const freshBrowser = await launch(engine);
  let controlBrowser: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const fresh = await createTab(freshBrowser.browser);
    controlBrowser = await launch(engine);
    const control = await createTab(controlBrowser.browser);
    if (values["match-styles"]) {
      await matchStyles(tab.page, fresh.page);
      await matchStyles(tab.page, control.page);
    }
    for (const [role, current] of [
      ["fresh", fresh],
      ["control", control],
      ["aged", tab],
    ] as const) {
      checkpoints.push({
        engine,
        stage,
        role,
        phase: "before-preparation",
        ...(await census(current.page)),
      });
    }
    for (const action of actions) {
      for (let index = 0; index < samples; index++) {
        for (const [role, current] of controlUiBenchOrder(
          [
            ["fresh", fresh],
            ["control", control],
            ["aged", tab],
          ] as const,
          index,
        )) {
          if (values["in-page"]) {
            await inPageSample(current, engine, stage, role, index, action);
          } else {
            await sample(current, engine, stage, role, index, action);
          }
        }
      }
      console.log(JSON.stringify({ engine, stage, action: action.id, phase: "sampled" }));
    }
    for (const [role, current] of [
      ["fresh", fresh],
      ["control", control],
      ["aged", tab],
    ] as const) {
      await current.page.bringToFront();
      await openChat(current.page);
      await current.page.waitForTimeout(4_100);
      let memory;
      let graph;
      if (values.heap) {
        const file = path.join(output, `${engine}-${stage}-${role}.heapsnapshot`);
        const collector = await createEngineMemoryCollector(current.page, engine);
        try {
          memory = await collector.capture(file);
          if (engine === "chromium") {
            graph = summarizeRetentionHeap(JSON.parse(await readFile(file, "utf8")));
          }
        } finally {
          await collector.dispose();
        }
        await unlink(file);
      }
      checkpoints.push({ engine, stage, role, ...(await census(current.page)), memory, graph });
      await current.page.evaluate(() => {
        // SAFETY: Every tab installs the typed synthetic Gateway before navigation.
        (window as MockGatewayWindow).openclawControlUiE2eGateway!.requests.length = 0;
      });
      await current.page.screenshot({ path: path.join(output, `${engine}-${stage}-${role}.png`) });
    }
    await json("checkpoints.json", checkpoints);
    console.log(
      JSON.stringify({
        engine,
        stage,
        samples,
        elapsedMinutes: (Date.now() - started) / 60_000,
        load: os.loadavg(),
      }),
    );
  } finally {
    await controlBrowser?.close();
    await freshBrowser.close();
  }
}
const running: Array<{
  engine: ControlUiEngine;
  browser: Browser;
  aged: Tab;
  idle: Tab;
  idleTiming: JSHandle<ReturnType<typeof createEngineActionTiming>>;
  idleStart: number;
  restore?: () => Promise<void>;
}> = [];
const closeBrowsers: Array<() => Promise<void>> = [];
try {
  for (const engine of engines) {
    const native = await launch(engine);
    const browser = native.browser;
    closeBrowsers.push(native.close);
    const aged = await createTab(browser);
    const idle = await createTab(browser, native.context);
    await actions[0]!.prepare(idle.page, idle.gateway);
    const idleTiming = await idle.page.evaluateHandle(createEngineActionTiming, false);
    await idleTiming.evaluate((timing) => timing.start());
    let restore: (() => Promise<void>) | undefined;
    if (engine === "chromium") {
      const cdp = await idle.context.newCDPSession(idle.page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      await idle.page.waitForFunction(() => document.visibilityState === "hidden", undefined, {
        timeout: 5_000,
        polling: 100,
      });
      restore = async () => {
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        await cdp.detach();
      };
    }
    checkpoints.push({ engine, stage: "idle-start", role: "idle", ...(await census(idle.page)) });
    running.push({ engine, browser, aged, idle, idleTiming, idleStart: Date.now(), restore });
  }
  for (const run of running) {
    await checkpoint(run.aged, run.engine, "fresh");
    await soak.run(run.aged.page, run.aged.gateway, async (label) => {
      if (
        label === "round-1" ||
        label === `round-${Math.ceil(rounds / 2)}` ||
        label === `round-${rounds}`
      ) {
        await checkpoint(run.aged, run.engine, label);
      }
    });
  }
  for (const run of running) {
    while (Date.now() - run.idleStart < idleMinutes * 60_000) {
      console.log(
        JSON.stringify({
          engine: run.engine,
          idleRemainingMinutes: Math.ceil(
            (idleMinutes * 60_000 - Date.now() + run.idleStart) / 60_000,
          ),
        }),
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 60_000);
      });
    }
    const wakeStart = performance.now();
    await run.restore?.();
    // Focus and observation were prepared before idle. Do not evaluate or warm the tab before input.
    await run.idle.page.keyboard.type("Synthetic typing 0123456789");
    await frames(run.idle.page);
    const wakeWallMs = performance.now() - wakeStart;
    if (
      (await run.idle.page.locator(`${pane} textarea`).first().inputValue()) !==
      "Synthetic typing 0123456789"
    ) {
      throw new Error("First idle input lost its draft");
    }
    const idleTiming = await run.idleTiming.evaluate((timing) => {
      timing.endScenario();
      return timing.finish();
    });
    await run.idleTiming.dispose();
    observations.push({
      engine: run.engine,
      stage: "idle-first-input",
      role: "idle",
      action: "typing",
      wakeWallMs,
      timing: idleTiming,
      load: os.loadavg(),
    });
    await json("observations.json", observations);
    await checkpoint(run.idle, run.engine, "idle-end");
    await checkpoint(run.aged, run.engine, "aged-end");
  }
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await json("checkpoints.json", checkpoints);
  for (const close of closeBrowsers) {
    await close();
  }
  await server.close();
}
console.log(JSON.stringify({ complete: true, elapsedMinutes: (Date.now() - started) / 60_000 }));
