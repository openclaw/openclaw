// Per-method RPC isolation against an unchanged production bundle and the shared mock Gateway.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { selectControlUiRoutePreloads } from "../src/gateway/control-ui-route-preloads.ts";
import { APP_ROUTE_IDS, type RouteId } from "../ui/src/app-route-paths.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  captureControlUiE2eRendererStall,
  installControlUiE2eRendererStallProbe,
} from "../ui/src/test-helpers/control-ui-e2e-renderer-stall.ts";
import {
  controlUiSessionPath,
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  resolvePlaywrightChromiumExecutablePath,
  startBuiltControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../ui/src/test-helpers/control-ui-plugin-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import {
  createEnginePageScenarios,
  enginePageCoverage,
} from "./lib/control-ui-engine-page-scenarios.ts";
import {
  createInteractionFixture,
  createScenarioFixture,
} from "./lib/control-ui-interaction-scenarios.ts";
import {
  createWorkboardResourceFixture,
  prepareWorkboardResourceSource,
} from "./lib/control-ui-workboard-resource-fixture.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "source-root": { type: "string", default: "." },
    output: { type: "string", default: ".artifacts/rpc-hostage" },
    mode: { type: "string", default: "discover" },
    flows: { type: "string", default: "all" },
    methods: { type: "string" },
    engines: { type: "string", default: "chromium" },
    delays: { type: "string", default: "3000,forever" },
    "rpc-rtt-ms": { type: "string", default: "0" },
    "observe-ms": { type: "string", default: "4000" },
    "settle-ms": { type: "string", default: "600" },
    screenshots: { type: "boolean", default: false },
    diagnose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(`RPC hostage benchmark: --mode discover|census --bundle-dir BASE
  --flows all|cold,warm,session-switch,usage,...
  [--methods method,...] [--engines chromium,webkit,firefox]
  [--delays 3000,forever] [--rpc-rtt-ms 0|100] [--observe-ms 4000]
  [--source-root CHECKOUT] [--screenshots] --output DIR
Census discovers methods per flow, then holds one method at a time.
Use bench-control-ui-engines.ts for paired timing proof. No bundle is built here.`);
  process.exit(0);
}
assert(["discover", "census"].includes(values.mode), "Unknown --mode");
const observeMs = Number(values["observe-ms"]);
const settleMs = Number(values["settle-ms"]);
const rpcRttMs = Number(values["rpc-rtt-ms"]);
assert([observeMs, settleMs, rpcRttMs].every((n) => Number.isFinite(n) && n >= 0));
const engines = values.engines.split(",").map((id) => {
  assert(id === "chromium" || id === "webkit" || id === "firefox", `Unknown engine ${id}`);
  return id;
});
type Engine = (typeof engines)[number];
type Delay = number | "forever";
const delays: Delay[] = values.delays.split(",").map((value) => {
  if (value === "forever") {
    return value;
  }
  const delay = Number(value);
  assert(Number.isFinite(delay) && delay >= 0, `Invalid delay ${value}`);
  return delay;
});
const allFlows = ["cold", "warm", "session-switch", ...APP_ROUTE_IDS];
const flows = values.flows === "all" ? allFlows : values.flows.split(",");
assert(
  flows.every((flow) => allFlows.includes(flow)),
  "Unknown flow",
);
const selectedMethods = values.methods?.split(",");
const output = path.resolve(values.output);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const harnessSha256 = createHash("sha256")
  .update(await readFile(new URL(import.meta.url)))
  .digest("hex");
await mkdir(output, { recursive: true });
const sessionKeys = ["agent:main:interaction-a", "agent:main:interaction-b"];
const bootPath = controlUiSessionPath(sessionKeys[0]!);
const pageScenarios = createEnginePageScenarios(0, "chat");
const workboardPageScenarios = createEnginePageScenarios(0, "new-session");
const bootFlows = new Set(["cold", "warm", "session-switch"]);
const pageScenario = (flow: string) =>
  (flow === "workboard" || flow === "plugin" ? workboardPageScenarios : pageScenarios).find(
    (entry) => entry.id === `page-${flow}-visit`,
  );
const needsWorkboard = flows.some((flow) => pageScenario(flow)?.fixture?.workboardResources);
const flowCoverage = flows.map((flow) => {
  const coverage = enginePageCoverage.find((entry) => entry.id === flow);
  if (bootFlows.has(flow)) {
    return { flow, status: "measured", fixture: "interaction" };
  }
  assert(coverage, `Missing route coverage: ${flow}`);
  return { flow, ...coverage, fixture: pageScenario(flow)?.id };
});

type Destination = {
  routeId: RouteId;
  pathname: string;
  search: string;
  sessionKey: string | null;
};
type Point =
  | "shell"
  | "route"
  | "roster"
  | "composer"
  | "transcript"
  | "content"
  | "inventory"
  | "policy"
  | "bindings";
type Observation = {
  elapsedMs: number;
  first: Record<Point, number | null>;
  readiness: Record<Point, boolean>;
  pathname: string;
  search: string;
  routeId: string | null;
  sessionKey: string | null;
  routeStatus: string | null;
  pendingRoutes: number;
  gatewayPhase: string | null;
  rosterReady: boolean;
  routeReady: boolean;
  composerPresent: boolean;
  composerEditable: boolean;
  text: string;
  skeletons: number;
  alerts: string[];
  renderFailures: string[];
  visibleRows: number;
  visibleEmptyStates: number;
  lastInputMs: number | null;
  methods: Record<string, number>;
};
type Probe = {
  reset: (routeId: string, sessionKey?: string, redirected?: boolean) => void;
  read: () => Observation;
  matchesDestination: (destination: Destination) => boolean;
};
declare global {
  interface Window {
    rpcHostageProbe: Probe;
  }
}

// All timestamps originate in the application document. Driver round trips do not
// define readiness; a pending point remains null instead of becoming the timeout.
function installProbe() {
  let start = 0;
  let routeId = "chat";
  let sessionKey: string | undefined;
  let redirected = false;
  let requestOffset = 0;
  let lastInputMs: number | null = null;
  let first: Record<Point, number | null>;
  const visible = (element: Element | null) => {
    if (!element || element.closest('[hidden], [inert], [aria-hidden="true"]')) {
      return false;
    }
    const bounds = element.getBoundingClientRect();
    return (
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      bounds.bottom > 0 &&
      bounds.right > 0 &&
      bounds.top < innerHeight &&
      bounds.left < innerWidth
    );
  };
  const read = (): Observation => {
    const snapshot = window.openclawControlUi?.snapshot();
    const route = snapshot?.route;
    const actualRoute = route?.matches[0]?.routeId ?? null;
    const ready = snapshot?.routeReady === true && (actualRoute === routeId || redirected);
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const correctSession = !sessionKey || snapshot?.sessionKey === sessionKey;
    const composer = [
      ...document.querySelectorAll<HTMLTextAreaElement>(
        ".agent-chat__composer-combobox textarea, .new-session-page textarea",
      ),
    ].find(visible);
    // innerText follows presentation visibility, excluding parked Chat panes.
    const content = document.querySelector<HTMLElement>("openclaw-router-outlet");
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- Evidence must exclude hidden parked panes; textContent includes them.
    const text = content?.innerText?.trim() ?? "";
    const states: Record<Point, boolean> = {
      shell: visible(document.querySelector("openclaw-app-shell")),
      route: ready,
      roster: snapshot?.rosterReady === true,
      composer: correctSession && Boolean(composer && !composer.disabled && !composer.readOnly),
      transcript:
        correctSession &&
        ready &&
        [...(pane?.querySelectorAll(".chat-bubble") ?? [])].some(visible),
      content: ready && Boolean(text),
      inventory:
        (routeId === "devices" &&
          visible(document.querySelector("openclaw-devices-page .device-entry[data-device-id]"))) ||
        (routeId === "systems" && visible(document.querySelector(".systems-machine"))),
      policy:
        routeId === "devices" &&
        Boolean(document.querySelector('openclaw-devices-page select[aria-label="Security"]')),
      bindings:
        routeId === "devices" &&
        Boolean(
          document.querySelector('openclaw-devices-page select[aria-label="Device"]:enabled'),
        ),
    };
    for (const point of Object.keys(states) as Point[]) {
      if (states[point]) {
        first[point] ??= performance.now() - start;
      }
    }
    const methods: Record<string, number> = {};
    const requests = (window as MockGatewayWindow).openclawControlUiE2eGateway?.requests ?? [];
    for (let i = requestOffset; i < requests.length; i++) {
      const method = requests[i]!.method;
      methods[method] = (methods[method] ?? 0) + 1;
    }
    return {
      elapsedMs: performance.now() - start,
      first: { ...first },
      readiness: states,
      pathname: location.pathname,
      search: location.search,
      routeId: actualRoute,
      sessionKey: snapshot?.sessionKey ?? null,
      routeStatus: route?.status ?? null,
      pendingRoutes: route?.pendingMatches.length ?? 0,
      gatewayPhase: snapshot?.gatewayPhase ?? null,
      rosterReady: snapshot?.rosterReady === true,
      routeReady: ready,
      composerPresent: Boolean(composer),
      composerEditable: states.composer,
      text: text.slice(0, 2200),
      skeletons: [...document.querySelectorAll('[class*="skeleton"], [aria-busy="true"]')].filter(
        visible,
      ).length,
      alerts: [...document.querySelectorAll('[role="alert"], .error-message')]
        .filter(visible)
        .map((node) => node.textContent?.trim() ?? ""),
      renderFailures: [...document.querySelectorAll(".lazy-view-error")]
        .filter(visible)
        .map((node) => node.textContent?.trim() ?? ""),
      visibleRows: [
        ...document.querySelectorAll(
          ".data-table tbody tr:not(.session-skeleton-row), .cron-job, .device-entry, .activity-entry, .systems-machine",
        ),
      ].filter(visible).length,
      visibleEmptyStates: [
        ...document.querySelectorAll(".settings-empty, .data-table-empty-state, .empty-state"),
      ].filter(visible).length,
      lastInputMs,
      methods,
    };
  };
  const probe: Probe = {
    matchesDestination(expected) {
      const state = window.openclawControlUi?.snapshot();
      return Boolean(
        state?.routeReady &&
        state.route?.status === "success" &&
        state.route.pendingMatches.length === 0 &&
        state.route.matches[0]?.routeId === expected.routeId &&
        location.pathname === expected.pathname &&
        location.search === expected.search &&
        (!expected.sessionKey || state.sessionKey === expected.sessionKey),
      );
    },
    reset(expectedRoute, expectedSession, isRedirect = false) {
      start = performance.now();
      routeId = expectedRoute;
      sessionKey = expectedSession;
      redirected = isRedirect;
      requestOffset =
        (window as MockGatewayWindow).openclawControlUiE2eGateway?.requests.length ?? 0;
      lastInputMs = null;
      first = {
        shell: null,
        route: null,
        roster: null,
        composer: null,
        transcript: null,
        content: null,
        inventory: null,
        policy: null,
        bindings: null,
      };
    },
    read,
  };
  window.rpcHostageProbe = probe;
  probe.reset("chat");
  window.addEventListener("input", (event) => {
    if (event.target instanceof HTMLTextAreaElement) {
      lastInputMs = performance.now() - start;
    }
  });
  const tick = () => {
    read();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function makeServer(directory: string, label: string) {
  const resolved = path.resolve(directory);
  const html = await readFile(path.join(resolved, "index.html"), "utf8");
  const identity = html.match(
    /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
  )?.[1];
  assert(identity, `No build identity in ${resolved}`);
  const build: { buildId: string; version: string } = JSON.parse(identity);
  const workboardSource = needsWorkboard
    ? await prepareWorkboardResourceSource(values["source-root"])
    : undefined;
  const original = createInteractionFixture(build.buildId, build.version);
  const fixture = {
    ...original,
    featureMethods: [...defaultControlUiFeatureMethods, "templates.catalog.search"],
    methodResponses: {
      ...original.methodResponses,
      "templates.catalog.search": { entries: [] },
      "node.list": {
        ts: 1_800_000_000_000,
        nodes: [
          {
            nodeId: "rpc-hostage-node",
            displayName: "Synthetic RPC workstation",
            platform: "linux",
            paired: true,
            connected: true,
            caps: ["system"],
            commands: ["system.run"],
          },
        ],
      },
      "device.pair.list": { pending: [], paired: [] },
      "system-presence": [],
      "exec.approvals.get": {
        path: "/synthetic/exec-approvals.json",
        exists: true,
        hash: "rpc-hostage-approvals",
        file: { version: 1, defaults: { security: "deny", ask: "on-miss" }, agents: {} },
      },
    },
  } satisfies ControlUiMockGatewayScenario;
  const serving = path.join(output, `serve-${label}`);
  await mkdir(serving);
  await writeFile(
    path.join(serving, "index.html"),
    selectControlUiRoutePreloads(html, "chat")
      .replaceAll('src="./assets/', 'src="/assets/')
      .replaceAll('href="./assets/', 'href="/assets/'),
  );
  for (const entry of await readdir(resolved, { withFileTypes: true })) {
    if (entry.name.startsWith("index.html")) {
      continue;
    }
    await symlink(
      path.join(resolved, entry.name),
      path.join(serving, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
  const server = await startBuiltControlUiE2eServer(
    serving,
    createControlUiMockBootstrapConfig(fixture),
  );
  return { server, fixture, directory: resolved, build, workboardSource };
}
type Server = Awaited<ReturnType<typeof makeServer>>;

async function waitInDocument(page: Page, ms: number) {
  await page.evaluate(
    (duration) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, duration);
      }),
    ms,
  );
}
async function settledBoot(page: Page, slot: Server, workboard: boolean) {
  await page.goto(new URL(workboard ? "/new" : bootPath, slot.server.baseUrl).href);
  await page.waitForFunction(
    (fromNewSession) => {
      if (fromNewSession) {
        const state = window.openclawControlUi?.snapshot();
        return state?.routeReady && state.route?.matches[0]?.routeId === "new-session";
      }
      const state = window.rpcHostageProbe.read();
      return state.first.composer !== null && state.first.transcript !== null && state.rosterReady;
    },
    workboard,
    { timeout: 30_000 },
  );
  await waitInDocument(page, settleMs);
}
async function applyDelays(page: Page, method: string | null, delay: Delay, methodNames: string[]) {
  await page.evaluate(
    ({ target, duration, rtt, names }) => {
      const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
      // RTT is modeled once per RPC response, independently for every method.
      if (rtt) {
        for (const name of names) {
          gateway.setMethodDelay(name, rtt);
        }
      }
      if (target) {
        gateway.setMethodDelay(target, duration === "forever" ? duration : duration + rtt);
      }
    },
    { target: method, duration: delay, rtt: rpcRttMs, names: methodNames },
  );
}
async function editProbe(page: Page, flow: string) {
  if (!["cold", "warm", "chat", "session-switch", "new-session"].includes(flow)) {
    return { accepted: null, atMs: null };
  }
  const candidates = await page
    .locator(".agent-chat__composer-combobox textarea, .new-session-page textarea")
    .all();
  let composer;
  for (const candidate of candidates) {
    const visible = await candidate.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        bounds.bottom > 0 &&
        bounds.right > 0 &&
        bounds.top < innerHeight &&
        bounds.left < innerWidth
      );
    });
    if (visible && (await candidate.isEditable())) {
      composer = candidate;
      break;
    }
  }
  if (!composer) {
    return { accepted: false, atMs: null };
  }
  await composer.fill("Synthetic pending RPC input", { timeout: 1000 });
  const accepted = (await composer.inputValue()) === "Synthetic pending RPC input";
  const atMs = await page.evaluate(() => window.rpcHostageProbe.read().lastInputMs);
  await composer.fill("", { timeout: 1000 });
  return { accepted, atMs };
}

async function sample(
  browser: Browser,
  slot: Server,
  flow: string,
  method: string | null,
  delay: Delay,
  label: string,
  pair: number,
  knownMethods: string[],
  baselineDestination: Destination | null,
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  if (values.diagnose) {
    await installControlUiE2eRendererStallProbe(page);
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  const loadStart = loadavg();
  const definition = pageScenario(flow);
  const workboard = Boolean(definition?.fixture?.workboardResources);
  const fixture = workboard
    ? createWorkboardResourceFixture(
        slot.build.buildId,
        slot.build.version,
        slot.workboardSource!.root,
      )
    : definition
      ? createScenarioFixture(slot.build.buildId, slot.build.version, definition)
      : slot.fixture;
  const coverage = enginePageCoverage.find((entry) => entry.id === flow);
  const destination = new URL(coverage?.path ?? bootPath, slot.server.baseUrl);
  const routeId: RouteId = bootFlows.has(flow) ? "chat" : (flow as RouteId);
  const requestedDestination: Destination = {
    routeId,
    pathname:
      flow === "session-switch" || flow === "chat"
        ? controlUiSessionPath(sessionKeys[1]!)
        : flow === "cold" || flow === "warm"
          ? bootPath
          : flow === "dashboard"
            ? controlUiSessionPath(sessionKeys[0]!, "", "dashboard")
            : destination.pathname,
    search: destination.search,
    sessionKey:
      routeId === "chat" ? sessionKeys[flow === "cold" || flow === "warm" ? 0 : 1]! : null,
  };
  assert(!method || baselineDestination, "Delayed samples require a resolved baseline destination");
  const methodNames = [
    ...new Set([
      "connect",
      ...knownMethods,
      ...defaultControlUiFeatureMethods,
      ...Object.keys(fixture.methodResponses ?? {}),
    ]),
  ];
  const scenario: ControlUiMockGatewayScenario = {
    ...fixture,
    methodDelays:
      flow === "cold" || flow === "warm"
        ? {
            ...Object.fromEntries(methodNames.map((name) => [name, rpcRttMs])),
            ...(method ? { [method]: delay === "forever" ? delay : delay + rpcRttMs } : {}),
          }
        : {},
  };
  const sessions = createTeamScaleSidebarListOwner({
    rows: fixture.sessions ?? [],
    viewerProfileId: "interaction-viewer",
    now: 1_800_000_000_000,
    defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
    owners: [],
  });
  const defaults = {
    "sessions.list": (params: unknown) => {
      assert(isRecord(params), "Expected sessions.list parameters");
      return sessions.list(params).result;
    },
  };
  // One installer preserves mock/handler/probe order and the page fixture's
  // authenticated bootstrap, including conditional native plugin capabilities.
  await installNativePluginMockGateway(
    page,
    {
      ...(flow === "warm" ? fixture : scenario),
      awaitInitialRoster: false,
    },
    {
      requestHandlers: definition
        ? { ...defaults, ...definition.createRequestHandlers?.(defaults) }
        : undefined,
      afterInitScript: `;globalThis.__name = (fn) => fn; if (sessionStorage.getItem("rpc-hostage-warm")) {
      for (const [method, delay] of Object.entries(${JSON.stringify(scenario.methodDelays)})) {
        window.openclawControlUiE2eGateway.setMethodDelay(method, delay);
      }
    }; (${installProbe.toString()})();`,
    },
  );
  await definition?.setup?.(page);
  try {
    return await withTimeout(
      (async () => {
        if (flow === "cold") {
          await page.goto(new URL(bootPath, slot.server.baseUrl).href);
        } else {
          await settledBoot(page, slot, workboard);
          if (flow === "warm") {
            // Replace init script behavior for this reload without installing a second mock socket.
            await page.evaluate(() => sessionStorage.setItem("rpc-hostage-warm", "1"));
            await page.reload();
          } else {
            await applyDelays(page, method, delay, methodNames);
            await page.evaluate(
              ({ requested, redirected }) => {
                window.rpcHostageProbe.reset(
                  requested.routeId,
                  requested.sessionKey ?? undefined,
                  redirected,
                );
                window.openclawControlUi!.navigate(requested.routeId, {
                  pathname: requested.pathname,
                  search: requested.search,
                });
              },
              {
                requested: requestedDestination,
                redirected: coverage?.status === "redirect",
              },
            );
          }
        }
        const checkpoints: Array<
          Observation & { inputAccepted?: boolean | null; inputAtMs?: number | null }
        > = [];
        const intervals = [
          ...new Set([Math.min(300, observeMs), Math.min(1500, observeMs), observeMs]),
        ].toSorted((a, b) => a - b);
        for (const at of intervals) {
          await page.waitForFunction(
            (elapsed) => window.rpcHostageProbe.read().elapsedMs >= elapsed,
            at,
            { timeout: observeMs + 30_000 },
          );
          const observed = await page.evaluate(() => window.rpcHostageProbe.read());
          const input = checkpoints.length === 0 ? await editProbe(page, flow) : undefined;
          checkpoints.push({
            ...observed,
            ...(input ? { inputAccepted: input.accepted, inputAtMs: input.atMs } : {}),
          });
        }
        const finalInput = await editProbe(page, flow);
        const measured = checkpoints.at(-1)!;
        const expectedDestination: Destination | null =
          baselineDestination ??
          (measured.routeReady &&
          measured.routeId &&
          (measured.routeId === requestedDestination.routeId || coverage?.status === "redirect")
            ? {
                routeId: measured.routeId as RouteId,
                pathname: measured.pathname,
                search: measured.search,
                sessionKey: measured.routeId === "chat" ? measured.sessionKey : null,
              }
            : null);
        let released: Observation | null = null;
        let releaseRouteReady: boolean | null = null;
        let releaseDataReady: boolean | null = null;
        const capturePrefix = `${label}-${pair}-${flow}-${method ?? "none"}-${delay}`;
        if (values.screenshots) {
          await page.screenshot({ path: path.join(output, `${capturePrefix}-pending.png`) });
        }
        // Navigation proof happens after the timing/late-response window.
        const navigationWorks = await page.evaluate(async () => {
          const app = window.openclawControlUi;
          if (!app) {
            return false;
          }
          app.navigate("new-session", { pathname: "/new" });
          const deadline = performance.now() + 1500;
          while (performance.now() < deadline) {
            const state = app.snapshot();
            if (state.routeReady && state.route?.matches[0]?.routeId === "new-session") {
              return true;
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 20);
            });
          }
          return false;
        });
        // A blocked visit may still display the previous page. Restore the request,
        // then verify the baseline's committed destination before using its controls.
        await page.evaluate(({ routeId: targetRoute, pathname, search }) => {
          window.openclawControlUi?.navigate(targetRoute, { pathname, search });
        }, requestedDestination);
        let nativeNavigationWorks = false;
        let nativeNavigationError: string | null = null;
        try {
          assert(expectedDestination, "Baseline did not resolve the requested destination");
          await page.waitForFunction(
            (expected) => window.rpcHostageProbe.matchesDestination(expected),
            expectedDestination,
            { timeout: 1500 },
          );
          const back = page.locator(".settings-sidebar__back").filter({ visible: true }).first();
          if (await back.count()) {
            await back.click({ timeout: 1500 });
          }
          const newSession = page
            .locator('.sidebar-rail .sidebar-new-session[href], a[href="/new"], a[href^="/new?"]')
            .filter({ visible: true })
            .first();
          await newSession.click({ timeout: 1500 });
          await page.waitForFunction(
            () => {
              const state = window.openclawControlUi?.snapshot();
              return state?.routeReady && state.route?.matches[0]?.routeId === "new-session";
            },
            undefined,
            { timeout: 1500 },
          );
          nativeNavigationWorks = true;
        } catch (error) {
          nativeNavigationError = String(error);
        }
        if (method && delay === "forever") {
          // Re-enter the original destination while the method is still held, then
          // release it. This checks recovery without attributing the /new page to it.
          await page.evaluate(
            ({ requested, name }) => {
              window.openclawControlUi?.navigate(requested.routeId, {
                pathname: requested.pathname,
                search: requested.search,
              });
              (window as MockGatewayWindow).openclawControlUiE2eGateway!.setMethodDelay(name, null);
            },
            {
              requested: requestedDestination,
              name: method,
            },
          );
          releaseDataReady = await page
            .waitForFunction(
              ({ heldMethod, expected }) => {
                const state = window.rpcHostageProbe.read();
                if (!expected || !window.rpcHostageProbe.matchesDestination(expected)) {
                  return false;
                }
                if (state.routeId === "devices") {
                  return (
                    state.readiness.inventory &&
                    (heldMethod === "config.get"
                      ? state.readiness.bindings
                      : heldMethod === "exec.approvals.get"
                        ? state.readiness.policy
                        : true)
                  );
                }
                if (state.routeId === "systems") {
                  return state.readiness.inventory;
                }
                return state.routeId === "chat"
                  ? state.readiness.transcript && state.readiness.composer
                  : state.skeletons === 0;
              },
              { heldMethod: method, expected: expectedDestination },
              {
                timeout: 2000,
              },
            )
            .then(
              () => true,
              () => false,
            );
          released = await page.evaluate(() => window.rpcHostageProbe.read());
          releaseRouteReady = await page.evaluate(
            (expected) => Boolean(expected && window.rpcHostageProbe.matchesDestination(expected)),
            expectedDestination,
          );
          if (values.screenshots) {
            await page.screenshot({ path: path.join(output, `${capturePrefix}-released.png`) });
          }
        }
        return {
          label,
          pair,
          flow,
          method,
          delay,
          rpcRttMs,
          requestedDestination,
          expectedDestination,
          measured,
          checkpoints,
          released,
          releaseRouteReady,
          releaseDataReady,
          inputAccepted: finalInput.accepted,
          inputAtMs: finalInput.atMs,
          navigationWorks,
          nativeNavigationWorks,
          nativeNavigationError,
          errors,
          loadStart,
          loadEnd: loadavg(),
        };
      })(),
      45_000,
    );
  } catch (error) {
    const observation = await withTimeout(
      page.evaluate(() => window.rpcHostageProbe?.read()),
      1_000,
    ).catch((readError: unknown) => String(readError));
    await writeFile(
      path.join(output, `${label}-${pair}-${flow}-failure.json`),
      JSON.stringify(
        { error: String(error), pageErrors: errors, url: page.url(), observation },
        null,
        2,
      ),
    );
    if (values.diagnose) {
      const stall = await captureControlUiE2eRendererStall(page, "deadline");
      await writeFile(
        path.join(output, `${label}-${pair}-${flow}-stall.json`),
        JSON.stringify({ error: String(error), stall }, null, 2),
      );
    }
    throw error;
  } finally {
    await withTimeout(context.close(), 3_000).catch(async (error: unknown) => {
      await withTimeout(browser.close(), 3_000).catch(() => {});
      throw error;
    });
  }
}
type Sample = Awaited<ReturnType<typeof sample>>;
const results: Array<Sample & { engine: Engine }> = [];
const failures: Array<{
  engine: Engine;
  flow: string;
  method: string | null;
  delay: Delay;
  label: string;
  pair: number;
  error: string;
}> = [];
const discovered: Record<string, Record<string, string[]>> = {};
const slots: Server[] = [];
async function checkpoint() {
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        format: "control-ui-rpc-hostage-v1",
        revision,
        harnessSha256,
        options: values,
        builds: slots.map(({ directory, build, workboardSource }) => ({
          directory,
          build,
          ...(workboardSource ? { workboardSource } : {}),
        })),
        discovered,
        flowCoverage: flowCoverage.map((entry) => ({
          ...entry,
          observedDestinations: [
            ...new Set(
              results
                .filter((row) => row.flow === entry.flow && row.label === "discover")
                .map((row) => row.measured.routeId),
            ),
          ],
        })),
        results,
        failures,
        measurement:
          "Browser-local first animation-frame readiness, not paint or CPU. Programmatic navigation uses the app's existing automation entry. Input proof uses native textarea fill. Each flow owns a fresh context; warm retains the same browser context across one reload; service workers are blocked. Remote profile adds response delay only, not bandwidth or asset RTT.",
      },
      null,
      2,
    ),
  );
  const lines = [
    "# RPC hostage census",
    "",
    "Route coverage and fixture ownership are recorded in results.json (flowCoverage). Excluded/unavailable flows are not silently measured with generic data.",
    "",
    ...flowCoverage
      .filter((entry) => entry.status !== "measured")
      .map(
        (entry) =>
          `- ${entry.flow}: ${entry.status}${"reason" in entry && entry.reason ? ` — ${entry.reason}` : ""}`,
      ),
    "",
    "| Engine | Flow | Method | Delay | Route ms | Composer ms | Roster ms | Inventory ms | Policy ms | Input | API nav | Native nav | Skeletons | Errors |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|",
  ];
  for (const row of results) {
    const point = row.measured.first;
    lines.push(
      `| ${row.engine} | ${row.flow} | ${row.method ?? "baseline"} | ${row.delay} | ${point.route?.toFixed(1) ?? "pending"} | ${point.composer?.toFixed(1) ?? "pending"} | ${point.roster?.toFixed(1) ?? "pending"} | ${point.inventory?.toFixed(1) ?? "pending"} | ${point.policy?.toFixed(1) ?? "pending"} | ${row.inputAccepted} | ${row.navigationWorks} | ${row.nativeNavigationWorks} | ${row.measured.skeletons} | ${row.errors.length} |`,
    );
  }
  await writeFile(path.join(output, "report.md"), `${lines.join("\n")}\n`);
}
try {
  slots.push(await makeServer(values["bundle-dir"], "base"));
  for (const engine of engines) {
    const browserType = { chromium, webkit, firefox }[engine];
    const browser = await browserType.launch({
      headless: true,
      timeout: 15_000,
      ...(engine === "chromium"
        ? { executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()) }
        : {}),
    });
    try {
      discovered[engine] = {};
      for (const flow of flows) {
        const coverage = flowCoverage.find((entry) => entry.flow === flow);
        if (coverage?.status === "excluded" || coverage?.status === "unavailable") {
          await checkpoint();
          continue;
        }
        let baselineDestination: Destination | null = null;
        const record = async (
          slot: Server,
          method: string | null,
          delay: Delay,
          label: string,
          pair: number,
        ) => {
          try {
            const result = await sample(
              browser,
              slot,
              flow,
              method,
              delay,
              label,
              pair,
              discovered[engine]?.[flow] ?? [],
              baselineDestination,
            );
            results.push({ engine, ...result });
            console.log(
              JSON.stringify({
                engine,
                flow,
                method,
                delay,
                label,
                pair,
                first: result.measured.first,
                methods: result.measured.methods,
              }),
            );
            return result;
          } catch (error) {
            failures.push({ engine, flow, method, delay, label, pair, error: String(error) });
            console.error(`${engine}/${flow}/${method ?? "baseline"}: ${String(error)}`);
            if (!browser.isConnected()) {
              throw error;
            }
            return undefined;
          } finally {
            await checkpoint();
          }
        };
        const baseline = await record(slots[0]!, null, 0, "discover", 0);
        if (!baseline) {
          continue;
        }
        if (baseline.errors.length || baseline.measured.renderFailures.length) {
          failures.push({
            engine,
            flow,
            method: null,
            delay: 0,
            label: "discover",
            pair: 0,
            error: `Baseline setup failed: ${JSON.stringify([...baseline.errors, ...baseline.measured.renderFailures])}`,
          });
          await checkpoint();
          continue;
        }
        const expectedRoute = ["cold", "warm", "session-switch"].includes(flow) ? "chat" : flow;
        if (
          !baseline.expectedDestination ||
          (baseline.measured.routeId !== expectedRoute && coverage?.status !== "redirect")
        ) {
          failures.push({
            engine,
            flow,
            method: null,
            delay: 0,
            label: "discover",
            pair: 0,
            error: `Flow did not settle: expected ${expectedRoute}, got ${baseline.measured.routeId} (ready=${baseline.measured.routeReady})`,
          });
          await checkpoint();
          continue;
        }
        baselineDestination = baseline.expectedDestination;
        const observedMethods = Object.keys(baseline?.measured.methods ?? {});
        const methods = observedMethods.filter(
          (method) => !selectedMethods || selectedMethods.includes(method),
        );
        discovered[engine]![flow] = observedMethods;
        if (values.mode === "discover") {
          continue;
        }
        // Explicit methods are still exercised when a baseline never reached that request.
        for (const method of selectedMethods ?? methods) {
          for (const delay of delays) {
            await record(slots[0]!, method, delay, "base", 1);
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  for (const slot of slots) {
    await slot.server.close();
  }
}
await checkpoint();
if (failures.length) {
  process.exitCode = 1;
}
