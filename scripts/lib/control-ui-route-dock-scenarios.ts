// Opt-in cold Browser/Link Reader cells for bench-control-ui-route-leaks.ts.
// Native recipes: browser-route-handoff, chat-sidebar-panel-contract, and activity-session-git E2E.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "playwright";
import type {
  MockGatewayRequest,
  MockGatewayWindow,
} from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { waitForControlUiGatewayReady } from "../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  type ControlUiMockGatewayScenario,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../../ui/src/test-helpers/control-ui-session-fixtures.ts";
import { TEST_LINK_READER } from "../../ui/src/test-helpers/link-reader.ts";
import { qualifyRouteNetworkClock, routeNetworkPhase } from "./control-ui-route-network.ts";

export const DOCK_SCENARIO_IDS = [
  "browser-focus-existing",
  "browser-session-mobile-first-open",
  "browser-session-mobile-dark-first-open",
  "reader-activity-first-open",
] as const;
export type DockScenarioId = (typeof DOCK_SCENARIO_IDS)[number];
export const isDockScenario = (id: string): id is DockScenarioId =>
  DOCK_SCENARIO_IDS.some((candidate) => candidate === id);
const isBrowserSession = (id: DockScenarioId) => id.startsWith("browser-session-");
export const dockContextOptions = (id: DockScenarioId) =>
  isBrowserSession(id)
    ? {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        colorScheme:
          id === "browser-session-mobile-dark-first-open" ? ("dark" as const) : ("light" as const),
      }
    : { viewport: { width: 1440, height: 1000 } };
const sessionKey = "agent:main:work";
const browserTitle = "Selected page";
const browserUrl = "https://selected.example/";
const metricsFunction =
  "() => ({ cssWidth: window.innerWidth, cssHeight: window.innerHeight, title: document.title, url: location.href })";
const prUrl = "https://github.com/example/gateway/pull/17";
const prTitle = "Keep session state after reconnecting";
const prBody = "Read this pull request without leaving Activity.";
const subscribeMethod = "controlUi.sessionPullRequests.subscribe";
const pullRequestsEvent = "controlUi.sessionPullRequests.changed";
const activityRows = [
  ["agent:main:activity-frontend", "Activity feed improvements", "Alex Morgan", "main"],
  ["agent:reviewer:activity-review", "Review Gateway reconnection", "Casey Brooks", "reviewer"],
  ["agent:main:activity-branch", "Polish responsive navigation", "Sam Rivera", "main"],
  ["agent:main:activity-notes", "Release planning notes", "Alex Morgan", "main"],
] as const;
const reviewKey = activityRows[1][0];
const reviewRequest = {
  owner: "example",
  repo: "gateway",
  number: 17,
  branch: "fix/reconnect-session-state",
  title: prTitle,
  url: prUrl,
  state: "draft",
};
const repository = { owner: "example", repo: "control-ui" };
const pullRequest = {
  ...repository,
  number: 42,
  branch: "feature/activity-details",
  title: "Show Git progress in the activity feed",
  url: "https://github.com/example/control-ui/pull/42",
  state: "open",
  additions: 184,
  deletions: 27,
};
const ready = { rateLimited: false, status: "ready" };
const activitySnapshot = {
  sessions: {
    [activityRows[0][0]]: {
      ...ready,
      pullRequests: [
        pullRequest,
        {
          ...pullRequest,
          number: 39,
          state: "merged",
          url: "https://github.com/example/control-ui/pull/39",
          additions: 46,
          deletions: 12,
        },
      ],
      branch: { ...repository, branch: pullRequest.branch, additions: 205, deletions: 31 },
    },
    [reviewKey]: { ...ready, pullRequests: [reviewRequest] },
    [activityRows[2][0]]: {
      pullRequests: [],
      branch: {
        ...repository,
        branch: "feature/responsive-navigation-and-keyboard-shortcuts",
        additions: 1284,
        deletions: 96,
      },
      rateLimited: true,
      status: "rate-limited",
    },
    [activityRows[3][0]]: { ...ready, pullRequests: [] },
  },
};

export function dockTarget(id: DockScenarioId): {
  route: "browser-document" | "chat" | "activity";
  pathname: string;
  search: string;
  selector: string;
} {
  if (id === "browser-focus-existing") {
    return {
      route: "browser-document",
      pathname: "/focus/browser",
      search:
        "?sessionKey=agent%3Amain%3Awork&target=node&node=worker-a&profile=work&targetId=existing",
      selector: "openclaw-browser-document .bp-shot",
    };
  }
  return isBrowserSession(id)
    ? {
        route: "chat",
        pathname: new URL(controlUiSessionUrl("http://benchmark.invalid/", sessionKey)).pathname,
        search: "",
        selector: ".agent-chat__composer-combobox textarea",
      }
    : {
        route: "activity",
        pathname: "/activity",
        search: "",
        selector: '.activity-feed__pr[data-state="draft"]',
      };
}

export function dockFixture(
  build: { buildId: string; version: string },
  id: DockScenarioId,
): ControlUiMockGatewayScenario {
  const now = Date.now();
  const browser = id.startsWith("browser-");
  const sessions = browser
    ? [createControlUiSessionRow(sessionKey, "Browser fixture session", now, { agentId: "main" })]
    : activityRows.map(([key, label, owner, agentId], index) => ({
        key,
        label,
        agentId,
        kind: "direct",
        updatedAt: now - (index + 1) * 60_000,
        createdActor: { type: "human", id: owner, label: owner },
      }));
  const list = (rows: typeof sessions) => ({
    count: rows.length,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: rows,
    ts: now,
  });
  const tab = { targetId: "existing", title: browserTitle, url: browserUrl };
  const messages = [
    { role: "assistant", content: "Browser fixture history is ready.", timestamp: now },
  ];
  return {
    serverBuildId: build.buildId,
    serverVersion: build.version,
    sessionKey,
    sessions,
    historyMessages: messages,
    sessionTranscripts: { [sessionKey]: { messages } },
    automaticallyFetchFavicons: false,
    operatorScopes: ["operator.admin", "operator.read", "operator.write"],
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      ...(browser ? ["browser.request"] : ["forge.preview", "forge.detail", subscribeMethod]),
    ],
    featureEvents: browser ? [] : [pullRequestsEvent],
    controlUiLinkReaders: browser ? [] : [TEST_LINK_READER],
    methodResponses: browser
      ? {
          "question.list": { questions: [] },
          "browser.request": {
            cases: [
              {
                match: { path: "/tabs" },
                response: {
                  running: true,
                  tabs:
                    id === "browser-focus-existing"
                      ? [
                          {
                            targetId: "unrelated",
                            title: "Other session",
                            url: "https://other.example/",
                          },
                          tab,
                        ]
                      : [tab],
                },
              },
              {
                match: { path: "/screenshot" },
                response: { targetId: tab.targetId, path: "/proof/selected.png", url: tab.url },
              },
              {
                match: { path: "/act" },
                response: {
                  result: { cssWidth: 100, cssHeight: 100, title: tab.title, url: tab.url },
                },
              },
              {
                match: { path: "/screencast" },
                response: {
                  __mockError: {
                    code: "UNAVAILABLE",
                    message: "Browser screencast requires Playwright in this gateway build.",
                    details: { code: "SCREENCAST_UNSUPPORTED", reason: "playwright" },
                  },
                },
              },
            ],
          },
        }
      : {
          "sessions.list": {
            cases: [
              { match: { includePeople: true }, response: list(sessions) },
              { response: list([]) },
            ],
          },
          [subscribeMethod]: { subscribed: true },
          "forge.detail": { url: prUrl, title: prTitle, body: prBody, comments: [] },
          "forge.preview": { url: prUrl, title: prTitle },
        },
  };
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=",
  "base64",
);
export function dockAsset(id: DockScenarioId, pathname: string) {
  return id.startsWith("browser-") && pathname === "/__openclaw__/assistant-media"
    ? { body: png, contentType: "image/png" }
    : undefined;
}

// Called by the driver's init script, before navigation. Only observes native input.
export function installDockInputTrace() {
  const events: Array<{ type: string; ms: number; target: string }> = [];
  Object.assign(window, { __routeDockNativeInputs: events });
  for (const type of ["pointerdown", "touchstart", "click"]) {
    document.addEventListener(
      type,
      (event) => {
        if (event.isTrusted && event.target instanceof Element) {
          events.push({
            type,
            ms: performance.now(),
            target:
              event.target.closest("button,a")?.outerHTML.slice(0, 500) ?? event.target.tagName,
          });
        }
      },
      { capture: true, passive: true },
    );
  }
}

export type DockAssetRequest = {
  requestId: string;
  url: string;
  type: string;
  initiator: unknown;
  timestampSeconds: number;
  finishedTimestampSeconds?: number;
  failedTimestampSeconds?: number;
  wireBytes?: number;
  status?: number;
  failed?: string;
};
type Coverage = Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>>;
type Metrics = Record<string, number>;
type CaptureApi = {
  id: DockScenarioId;
  mode: "coverage" | "timing";
  page: Page;
  cdp: CDPSession;
  requests: Map<string, DockAssetRequest>;
  before: Metrics;
  output: string;
  prefix: string;
  screenshots: boolean;
  result: Record<string, unknown>;
  metrics: (cdp: CDPSession) => Promise<Metrics>;
  cpuDelta: (before: Metrics, after: Metrics) => Metrics;
  summarize: (coverage: Coverage, requests: DockAssetRequest[]) => Promise<unknown>;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nativePane = (page: Page) =>
  page
    .locator(
      ".chat-pane-cache__pane--active, .chat-split-view__cell--active openclaw-chat-pane.chat-split-view__pane",
    )
    .filter({ visible: true })
    .first();
const draftLink = (page: Page) =>
  page
    .locator(".activity-feed__session-row")
    .filter({ has: page.locator(`[data-activity-session="${reviewKey}"]`) })
    .locator('.activity-feed__pr[data-state="draft"]');

async function routeReady(page: Page, routeId: string) {
  await waitForControlUiGatewayReady(page, 30_000);
  await page.waitForFunction(
    (id) => {
      const view = window.openclawControlUi?.snapshot();
      return (
        view?.routeReady &&
        view.route?.status === "success" &&
        view.route.matches[0]?.routeId === id &&
        view.route.pendingMatches.length === 0
      );
    },
    routeId,
    { timeout: 30_000 },
  );
}
async function browserReady(page: Page) {
  await page
    .locator('openclaw-browser-panel .bp-viewport[aria-busy="false"]')
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    (title) => {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>("openclaw-browser-panel .bp-shot"),
      ];
      return images.some(
        (image) =>
          image.alt === title &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.getClientRects().length > 0,
      );
    },
    browserTitle,
    { timeout: 30_000 },
  );
  await page
    .locator("openclaw-browser-panel .bp-toolbar")
    .getByRole("button", { name: "Reload", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator("openclaw-browser-panel .bp-toolbar")
      .getByRole("button", { name: "Reload", exact: true })
      .isEnabled(),
    true,
  );
}
async function coldReady(page: Page, id: DockScenarioId) {
  if (id === "browser-focus-existing") {
    await waitForControlUiGatewayReady(page, 30_000);
    await page.locator("openclaw-browser-document").waitFor();
    await browserReady(page);
    assert.equal(await page.locator("openclaw-app-shell, openclaw-desktop-panel").count(), 0);
    assert.equal(await page.locator("openclaw-browser-panel").count(), 1);
    assert.equal(await page.getByRole("button", { name: "New tab", exact: true }).count(), 0);
    return;
  }
  if (isBrowserSession(id)) {
    await routeReady(page, "chat");
    const composer = nativePane(page).locator(".agent-chat__composer-combobox textarea");
    await composer.waitFor();
    assert.equal(await composer.isEditable(), true);
    await page.getByText("Browser fixture history is ready.", { exact: true }).waitFor();
    await page.waitForFunction(
      (key) =>
        window.openclawControlUi?.snapshot().sessionKey === key &&
        (window as MockGatewayWindow).openclawControlUiE2eGateway
          ?.findRequests()
          .some((request) => {
            const params = request.params as {
              sessionKey?: string;
              key?: string;
              initialHistory?: unknown;
            };
            return (
              (["chat.startup", "chat.history"].includes(request.method) &&
                params?.sessionKey === key) ||
              (request.method === "sessions.messages.subscribe" &&
                params?.key === key &&
                params.initialHistory !== undefined)
            );
          }),
      sessionKey,
    );
    assert.equal(
      await page.locator("openclaw-browser-panel, openclaw-browser-tab-card").count(),
      0,
    );
    return;
  }
  await routeReady(page, "activity");
  await page.waitForFunction(
    ({ method, keys }) => {
      const requests =
        (window as MockGatewayWindow).openclawControlUiE2eGateway?.findRequests(method) ?? [];
      return requests.some((request) =>
        keys.every((key) =>
          (request.params as { sessionKeys?: string[] })?.sessionKeys?.includes(key),
        ),
      );
    },
    { method: subscribeMethod, keys: activityRows.map(([key]) => key) },
  );
  await page.evaluate(
    ({ event, payload }) =>
      (window as MockGatewayWindow).openclawControlUiE2eGateway!.emit(event, payload),
    { event: pullRequestsEvent, payload: activitySnapshot },
  );
  const link = draftLink(page);
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), prUrl);
  assert.match((await link.textContent()) ?? "", /gateway#17/u);
  assert.equal(await page.locator("openclaw-activity-page [data-activity-session]").count(), 4);
  assert.equal(await page.locator("openclaw-link-reader-panel").count(), 0);
}
async function openDock(page: Page, id: DockScenarioId) {
  if (isBrowserSession(id)) {
    // Native chat-layout-menu.ts recipe; avoid its Vitest runtime import.
    const pane = nativePane(page);
    const host = pane.locator(".chat-mobile-host");
    const mobileHeader = pane.locator(".agent-chat__header--mobile");
    await mobileHeader.waitFor({ state: "visible" });
    const mobileToggle = mobileHeader.getByRole("button", { name: "Panels", exact: true });
    if (await mobileToggle.isVisible()) {
      if (!(await host.isVisible())) {
        await mobileToggle.click();
      }
    } else {
      const trigger = pane
        .locator(".chat-header-session-menu__trigger")
        .filter({ visible: true })
        .first();
      const menu = trigger.locator("xpath=ancestor::openclaw-chat-header-session-menu[1]");
      if (!(await menu.locator(".oc-menu:visible").count())) {
        await trigger.click();
      }
      await menu.locator(".oc-menu:visible").first().waitFor();
      await menu.getByRole("menuitem", { name: "Panels", exact: true }).click();
    }
    await host.getByRole("button", { name: "Panels", exact: true }).click();
    await pane
      .locator(".chat-panel-launcher-mobile")
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    await browserReady(page);
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      id === "browser-session-mobile-dark-first-open" ? "dark" : "light",
    );
    assert.equal(await pane.locator(".sidebar-region--mobile-host").count(), 1);
    assert.equal(
      await page.locator("openclaw-browser-panel .bp-toolbar").getAttribute("data-mobile"),
      "true",
    );
    return;
  }
  const link = draftLink(page);
  await link.click();
  const panel = page.locator("openclaw-link-reader-panel");
  await panel.locator(".link-reader-panel").waitFor();
  await panel.getByRole("heading", { name: prTitle, exact: true }).waitFor();
  await panel.getByText(prBody, { exact: true }).waitFor();
  assert.equal(await panel.count(), 1);
  assert.equal(
    await panel.getByRole("button", { name: "Close link reader", exact: true }).isEnabled(),
    true,
  );
  assert.equal(await panel.locator('[role="alert"]:visible, .lr-loading:visible').count(), 0);
  assert.equal(new URL(page.url()).pathname, "/activity");
  assert.equal(page.context().pages().length, 1);
}

// Explicit reads/subscription management. Any unlisted method fails qualification.
const readMethods = new Set([
  "connect",
  "health",
  "status",
  "system.info",
  "config.get",
  "config.schema",
  "agents.list",
  "agent.identity.get",
  "artifacts.list",
  "models.list",
  "models.authStatus",
  "sessions.list",
  "sessions.resolve",
  "sessions.get",
  "sessions.subscribe",
  "sessions.unsubscribe",
  "sessions.messages.subscribe",
  "sessions.messages.unsubscribe",
  "sessions.groups.list",
  "sessions.groups.defaults",
  "sessions.search",
  "chat.startup",
  "chat.history",
  "chat.metadata",
  "commands.list",
  "cron.list",
  "cron.status",
  "plugins.list",
  "skills.status",
  "skills.library.list",
  "skills.workshop.list",
  "skills.workshop.changes",
  "users.self",
  "users.list",
  "users.listAuthLinks",
  "users.listModelAccounts",
  "users.github.status",
  "themes.get",
  "themes.list",
  "session.members.list",
  "session.members.listEvidence",
  "session.reactions.list",
  "sessions.companion.state",
  "sessions.processes.list",
  "sessions.diff",
  "exec.approval.list",
  "plugin.approval.list",
  "openclaw.approval.list",
  "update.status",
  "terminal.list",
  "tools.github.status",
  "sessions.github.options",
  "sessions.github.status",
  subscribeMethod,
  "controlUi.sessionPullRequests.unsubscribe",
]);
function validateRequests(id: DockScenarioId, requests: MockGatewayRequest[]) {
  for (const request of requests) {
    const params = record(request.params);
    if (request.method === "browser.request") {
      assert(id.startsWith("browser-"), "Reader sent a browser request");
      const body = record(params.body);
      const allowed =
        (params.path === "/tabs" && params.method === "GET" && params.body === undefined) ||
        (params.path === "/screenshot" &&
          params.method === "POST" &&
          body.targetId === "existing" &&
          body.type === "png" &&
          Object.keys(body).length === 2) ||
        (params.path === "/screencast" &&
          params.method === "POST" &&
          body.targetId === "existing" &&
          typeof body.maxWidth === "number" &&
          typeof body.maxHeight === "number" &&
          Object.keys(body).length === 3) ||
        (params.path === "/act" &&
          params.method === "POST" &&
          body.kind === "evaluate" &&
          body.targetId === "existing" &&
          body.fn === metricsFunction &&
          Object.keys(body).length === 3);
      assert(allowed, `Unexpected browser effect: ${JSON.stringify(params)}`);
      if (body.targetId !== undefined) {
        assert.equal(body.targetId, "existing");
      }
      if (id === "browser-focus-existing") {
        assert.equal(params.target, "node");
        assert.equal(params.node, "worker-a");
        assert.equal(record(params.query).profile, "work");
      } else {
        assert.equal(record(params.tabScope).sessionKey, sessionKey);
        assert(!Object.hasOwn(params, "target"));
        assert(!Object.hasOwn(params, "node"));
        assert(!Object.hasOwn(record(params.query), "profile"));
      }
    } else if (["forge.detail", "forge.preview"].includes(request.method)) {
      assert(id.startsWith("reader-"), "Browser sent a reader request");
      // Row previews use their row agent; the shell dock uses the selected agent.
      assert.deepEqual(params, {
        url: prUrl,
        agentId: request.method === "forge.preview" ? "reviewer" : "main",
      });
    } else if (
      ["talk.catalog", "progressCard.get", "sessions.branches.list"].includes(request.method)
    ) {
      assert(isBrowserSession(id));
      assert.deepEqual(request.params, { sessionKey });
    } else if (request.method === "talk.config") {
      assert(isBrowserSession(id));
      assert.deepEqual(request.params, {});
    } else if (request.method === "sessions.describe") {
      assert(isBrowserSession(id));
      // Cold remote startup may briefly describe the default session before route resolution.
      assert(params.key === sessionKey || params.key === "agent:main:main");
      assert.deepEqual(request.params, { key: params.key });
    } else if (request.method === "question.list") {
      assert(isBrowserSession(id));
      assert.deepEqual(request.params, {});
    } else if (request.method === "presence.activity") {
      assert.deepEqual(request.params, {});
    } else {
      assert(readMethods.has(request.method), `Unexpected Gateway effect: ${request.method}`);
    }
  }
}

// Each coverage interval has its own nested zero-count ranges. Flattening reports
// together would let a later zero erase work executed in an earlier interval.
function unionCoverage(phases: Coverage[]): Coverage {
  const urls = new Set(phases.flatMap((phase) => phase.map((entry) => entry.url)));
  return [...urls].map((url) => {
    const entries = phases.flatMap((phase) => phase.filter((entry) => entry.url === url));
    const length = Math.max(
      0,
      ...entries.flatMap((entry) =>
        entry.functions.flatMap((fn) => fn.ranges.map((range) => range.endOffset)),
      ),
    );
    const union = new Uint8Array(length);
    for (const entry of entries) {
      const mask = new Uint8Array(length);
      const ranges = entry.functions
        .flatMap((fn) => fn.ranges)
        .toSorted((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
      for (const range of ranges) {
        mask.fill(range.count > 0 ? 1 : 0, range.startOffset, range.endOffset);
      }
      for (let offset = 0; offset < length; offset++) {
        union[offset] = union[offset]! | mask[offset]!;
      }
    }
    const ranges = [{ startOffset: 0, endOffset: length, count: 0 }];
    for (let offset = 0; offset < length;) {
      if (!union[offset]) {
        offset++;
        continue;
      }
      const startOffset = offset;
      while (offset < length && union[offset]) {
        offset++;
      }
      ranges.push({ startOffset, endOffset: offset, count: 1 });
    }
    return Object.assign({}, entries[0]!, {
      functions: [{ functionName: "<derived interval union>", isBlockCoverage: true, ranges }],
    });
  });
}

export async function captureDockScenario(api: CaptureApi) {
  const { page, id } = api;
  const phases: Record<string, unknown>[] = [];
  const packets: Array<{
    id: string;
    startedMs: number;
    endedMs: number;
    navigationStart: number;
    coverage: Coverage;
    requests: DockAssetRequest[];
    cpu: Metrics;
    data: Awaited<ReturnType<typeof snapshot>>;
  }> = [];
  let activeCapture:
    | {
        id: string;
        startedMs: number;
        endedMs: number;
        requests: DockAssetRequest[];
        data: Awaited<ReturnType<typeof snapshot>>;
        coverage?: Coverage;
      }
    | undefined;
  const state: Record<string, unknown> = {
    id,
    measurement:
      api.mode === "coverage"
        ? "coverage-only; timing is diagnostic"
        : "coverage-free native action timing",
    fixture: "native E2E synthetic recipes; no live Gateway",
    phases,
  };
  api.result.dock = state;
  let coverageActive = api.mode === "coverage"; // The driver starts cold coverage only in coverage mode.
  async function snapshot() {
    return page.evaluate(() => ({
      ms: performance.now(),
      timeOrigin: performance.timeOrigin,
      url: location.href,
      rpc: (window as MockGatewayWindow).openclawControlUiE2eGateway?.findRequests() ?? [],
      resources: performance.getEntriesByType("resource").map((item) => {
        const resource = item as PerformanceResourceTiming;
        return {
          url: resource.name,
          startTime: resource.startTime,
          responseEnd: resource.responseEnd,
          rawBytes: resource.decodedBodySize,
          encodedBytes: resource.encodedBodySize,
          transferBytes: resource.transferSize,
          initiatorType: resource.initiatorType,
        };
      }),
      nativeInputs: (
        window as typeof window & {
          __routeDockNativeInputs: Array<{ type: string; ms: number; target: string }>;
        }
      )["__routeDockNativeInputs"],
      alerts: [...document.querySelectorAll('[role="alert"]')]
        .filter(
          (node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden",
        )
        .map((node) => node.textContent),
    }));
  }
  async function capture(label: string, startedMs: number, before: Metrics) {
    const endedMs = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          requestAnimationFrame(() => resolve(performance.now()));
        }),
    );
    const timingAfter = api.mode === "timing" ? await api.metrics(api.cdp) : undefined;
    const requests = Array.from(api.requests.values(), (request) => ({ ...request }));
    const data = await snapshot();
    activeCapture = { id: label, startedMs, endedMs, requests, data };
    const coverage = api.mode === "coverage" ? await page.coverage.stopJSCoverage() : [];
    activeCapture.coverage = coverage;
    coverageActive = false;
    const coverageStoppedMs =
      api.mode === "coverage" ? await page.evaluate(() => performance.now()) : undefined;
    const after = timingAfter ?? (await api.metrics(api.cdp));
    const packet = {
      id: label,
      startedMs,
      endedMs,
      coverageStoppedMs,
      navigationStart: after.NavigationStart!,
      requests,
      data,
      coverage,
      cpu: api.cpuDelta(before, after),
    };
    packets.push(packet);
    activeCapture = undefined;
    return packet;
  }
  try {
    await coldReady(page, id);
    const cold = await capture("cold", 0, api.before);
    api.result.readyMs = cold.endedMs;
    api.result.cpu = cold.cpu;
    if (id !== "browser-focus-existing") {
      // Begin action coverage before any native menu/link input or artifact processing.
      if (api.mode === "coverage") {
        await page.coverage.startJSCoverage({
          resetOnNavigation: false,
          reportAnonymousScripts: false,
        });
        coverageActive = true;
      }
      const before = await api.metrics(api.cdp);
      const started = await page.evaluate(() => performance.now());
      state.coldToActionGapMs = started - cold.endedMs;
      await openDock(page, id);
      await capture("first-open", started, before);
    }
    const opened = packets.at(-1)!;
    if (id !== "browser-focus-existing") {
      const inputs = opened.data.nativeInputs.filter(
        (input) => input.ms >= opened.startedMs && input.ms <= opened.endedMs,
      );
      assert(inputs.length > 0, "First-open has no trusted native input");
      state.action = {
        startedMs: opened.startedMs,
        firstNativeInputMs: inputs[0]!.ms,
        inputToReadyMs: opened.endedMs - inputs[0]!.ms,
        automationToReadyMs: opened.endedMs - opened.startedMs,
      };
    }
    state.frameUrls = page.frames().map((frame) => frame.url());
    state.workerUrls = page.workers().map((worker) => worker.url());
    assert.equal(page.frames().length, 1, "Child-frame coverage is not included in this cell");
    assert.equal(
      page.workers().length,
      0,
      "Dedicated-worker coverage is not included in this cell",
    );
    assert.equal(page.context().pages().length, 1, "Unexpected popup");
    assert.equal(opened.data.alerts.length, 0, "Unexpected visible alert");
    validateRequests(id, opened.data.rpc);
    if (id.startsWith("browser-")) {
      assert(
        opened.data.rpc.some(
          (request) =>
            request.method === "browser.request" && record(request.params).path === "/tabs",
        ),
      );
      assert(
        opened.data.rpc.some(
          (request) =>
            request.method === "browser.request" && record(request.params).path === "/screenshot",
        ),
      );
      assert(
        opened.data.resources.some(
          (resource) =>
            new URL(resource.url).pathname === "/__openclaw__/assistant-media" &&
            new URL(resource.url).searchParams.get("source") === "/proof/selected.png",
        ),
      );
    } else {
      assert(
        opened.data.rpc.some(
          (request) => request.method === "forge.detail" && record(request.params).url === prUrl,
        ),
      );
    }
    if (id !== "browser-focus-existing") {
      const coldRequests = cold.data.rpc.filter((request) =>
        ["browser.request", "forge.detail", "forge.preview"].includes(request.method),
      );
      assert.equal(coldRequests.length, 0, "Panel was warmed before native first-open");
      const panelPattern = id.startsWith("browser-")
        ? /\/browser-panel-[^/]+\.js$/u
        : /\/link-reader-panel-[^/]+\.js$/u;
      assert(
        api.mode !== "coverage" ||
          !cold.coverage.some(
            (entry) =>
              panelPattern.test(entry.url) &&
              entry.functions.some((fn) =>
                fn.ranges.some((range) => range.startOffset === 0 && range.count > 0),
              ),
          ),
        "Panel evaluated before native first-open",
      );
    }
    // Post-cutoff diagnostic reads do not enter the native timing/coverage packets above.
    state.visual = await page.evaluate(() => {
      const selectors = [
        ".sidebar-region--mobile-host",
        "openclaw-browser-panel",
        "openclaw-browser-panel .bp-toolbar",
        "openclaw-browser-panel .bp-toolbar-group",
        "openclaw-browser-panel .bp-icon",
        "openclaw-link-reader-panel .link-reader-panel",
        "openclaw-link-reader-panel .session-panel-rail",
      ];
      const properties = [
        "display",
        "background-color",
        "color",
        "font-size",
        "line-height",
        "height",
        "min-height",
        "padding",
        "gap",
        "border-bottom",
        "--mobile-panel-rail-height",
        "--mobile-panel-rail-background",
        "--mobile-panel-rail-control",
        "--mobile-panel-rail-icon",
        "--mobile-panel-rail-title-size",
      ];
      return {
        theme: document.documentElement.getAttribute("data-theme"),
        viewport: { width: innerWidth, height: innerHeight },
        nodes: selectors.flatMap((selector) =>
          Array.from(document.querySelectorAll(selector), (node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return {
              selector,
              tag: node.localName,
              classes: node.className,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              computed: Object.fromEntries(
                properties.map((property) => [property, style.getPropertyValue(property)]),
              ),
            };
          }),
        ),
        orderedStyles: Array.from(
          document.querySelectorAll("style,link[rel=stylesheet]"),
          (node) => ({
            tag: node.localName,
            href: node.getAttribute("href"),
            text: node.localName === "style" ? node.textContent : null,
          }),
        ),
      };
    });
    if (api.screenshots) {
      await page.screenshot({ path: path.join(api.output, `${api.prefix}-opened.png`) });
    }
    if (id === "browser-focus-existing") {
      await page.goto(new URL("/sessions", page.url()).href, { waitUntil: "domcontentloaded" });
      await routeReady(page, "sessions");
      await page
        .locator("openclaw-browser-document, openclaw-browser-panel")
        .waitFor({ state: "hidden" });
    } else if (isBrowserSession(id)) {
      await nativePane(page)
        .locator(".chat-mobile-host__header")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.locator("openclaw-browser-panel").waitFor({ state: "hidden" });
    } else {
      const close = page
        .locator("openclaw-link-reader-panel")
        .getByRole("button", { name: "Close link reader", exact: true });
      await close.click();
      await page
        .locator("openclaw-link-reader-panel .link-reader-panel")
        .waitFor({ state: "hidden" });
      await page.waitForFunction(
        (url) =>
          document.activeElement instanceof HTMLAnchorElement &&
          document.activeElement.href === url,
        prUrl,
      );
      assert.equal(new URL(page.url()).pathname, "/activity");
      assert.equal(await draftLink(page).isVisible(), true);
    }
    const closeStart = await snapshot();
    // Bounded post-close observation; not part of cold/first-open timing.
    await page.waitForTimeout(500);
    const closeEnd = await snapshot();
    validateRequests(id, closeEnd.rpc);
    const panelRpc = (requests: MockGatewayRequest[]) =>
      requests.filter((request) =>
        ["browser.request", "forge.detail", "forge.preview"].includes(request.method),
      );
    assert.deepEqual(
      panelRpc(closeEnd.rpc),
      panelRpc(closeStart.rpc),
      "Panel requests continued after close",
    );
    assert.equal(
      await page
        .locator(
          "openclaw-browser-panel:visible, openclaw-link-reader-panel .link-reader-panel:visible",
        )
        .count(),
      0,
    );
    state.close = {
      outcome: "hidden; no panel-request growth during 500ms observation",
      start: closeStart,
      end: closeEnd,
    };
    state.effects = {
      validated: true,
      scope: "synthetic protocol only; screenshot HTTP asset is synthetic",
      requestCount: opened.data.rpc.length,
    };
  } finally {
    if (activeCapture) {
      // Preserve captured evidence before cleanup observations can fail too.
      state.incompleteCapture = { ...activeCapture, incomplete: true };
    }
    if (coverageActive) {
      // Keep failure coverage before the outer driver closes this context.
      const requests =
        activeCapture?.requests ?? Array.from(api.requests.values(), (request) => ({ ...request }));
      const failure: Record<string, unknown> = {
        id: "failure",
        incomplete: true,
        requests,
      };
      state.incompleteCapture = failure;
      let data = activeCapture?.data;
      if (!data) {
        try {
          data = await snapshot();
        } catch (error) {
          failure.snapshotError = String(error);
        }
      }
      failure.data = data;
      let coverage: Coverage | undefined;
      try {
        coverage = await page.coverage.stopJSCoverage();
        failure.coverage = coverage;
        coverageActive = false;
      } catch (error) {
        failure.coverageError = String(error);
      }
      if (data && coverage) {
        try {
          const after = await api.metrics(api.cdp);
          packets.push({
            id: "failure",
            startedMs: 0,
            endedMs: data.ms,
            navigationStart: after.NavigationStart!,
            data,
            coverage,
            requests,
            cpu: {},
          });
        } catch (error) {
          failure.metricsError = String(error);
        }
      }
    }
    // Reconstruct the boundary from raw CDP clocks; a late completion is still
    // pending at cutoff even when its bytes are present in the later observation.
    const cutoffRequests = packets.map((packet) => {
      const cutoff = packet.navigationStart + packet.endedMs / 1_000;
      return packet.requests
        .filter((request) => request.timestampSeconds <= cutoff)
        .map((request) => {
          const atCutoff = Object.assign({}, request);
          if (
            atCutoff.finishedTimestampSeconds === undefined ||
            atCutoff.finishedTimestampSeconds > cutoff
          ) {
            delete atCutoff.finishedTimestampSeconds;
            delete atCutoff.wireBytes;
          }
          if (
            atCutoff.failedTimestampSeconds !== undefined &&
            atCutoff.failedTimestampSeconds > cutoff
          ) {
            delete atCutoff.failedTimestampSeconds;
            delete atCutoff.failed;
          }
          return atCutoff;
        });
    });
    const clocks = packets.map((packet, index) =>
      packet.id === "failure"
        ? undefined
        : qualifyRouteNetworkClock(
            cutoffRequests[index]!,
            packet.navigationStart,
            packet.data.resources.filter(
              (resource) => resource.responseEnd > 0 && resource.responseEnd <= packet.endedMs,
            ),
          ),
    );
    const clockPassed = clocks.every(
      (clock) => clock === undefined || (clock.passed && clock.unmatchedRequestIds.length === 0),
    );
    state.clockQualifications = clocks;
    // Keep raw evidence on failure, but publish no phase totals from an unqualified clock.
    for (const [index, packet] of packets.entries()) {
      const { requests: observedRequests, ...phasePacket } = packet;
      const phaseQualified = clockPassed && packet.id !== "failure";
      const atCutoff = cutoffRequests[index]!;
      const js = atCutoff.filter((request) => /\.m?js$/u.test(new URL(request.url).pathname));
      const previous = cutoffRequests[index - 1];
      const previousIds = new Set(previous?.map((request) => request.requestId));
      const newlyRequested = js.filter((request) => !previousIds.has(request.requestId));
      const evaluationRequests = js.filter((request) =>
        packet.coverage.some((entry) => entry.url === request.url),
      );
      const summaryRequests =
        packet.id === "cold"
          ? js
          : [
              ...new Map(
                [...newlyRequested, ...evaluationRequests].map((request) => [
                  request.requestId,
                  request,
                ]),
              ).values(),
            ];
      const file = `${api.prefix}-${packet.id}-v8.json`;
      if (api.mode === "coverage") {
        await writeFile(path.join(api.output, file), JSON.stringify(packet.coverage));
      }
      phases.push({
        ...phasePacket,
        coverage:
          phaseQualified && api.mode === "coverage"
            ? await api.summarize(packet.coverage, summaryRequests)
            : undefined,
        rawCoverageFile: api.mode === "coverage" ? file : undefined,
        observedRequests,
        requestsAtCutoff: atCutoff,
        clockQualification: clocks[index],
        networkAndCoverageTotalsWithheld: !phaseQualified,
        coverageCollected: api.mode === "coverage",
        intervalCoverageNote:
          api.mode === "timing"
            ? "Coverage disabled; phase CPU uses existing Performance threadTicks, captured before artifact snapshots."
            : packet.id === "cold"
              ? "navigation to cold ready"
              : "V8 ranges executed in this interval, including already fetched scripts; full raw source is not an additive byte delta",
        ...(phaseQualified
          ? {
              networkPhase: routeNetworkPhase(
                atCutoff,
                packet.navigationStart,
                packet.startedMs,
                packet.endedMs,
              ),
              newJsRequests: newlyRequested,
              httpJsWireBytesAtCutoff: js.reduce(
                (sum, request) => sum + (request.wireBytes ?? 0),
                0,
              ),
              pendingJsRequestsAtCutoff: js.filter(
                (request) => request.wireBytes === undefined && !request.failed,
              ).length,
              completedResourcesAtCutoff: packet.data.resources.filter(
                (resource) => resource.responseEnd > 0 && resource.responseEnd <= packet.endedMs,
              ),
              previousPendingCompleted: js.filter(
                (request) =>
                  previous?.some(
                    (prior) =>
                      prior.requestId === request.requestId && prior.wireBytes === undefined,
                  ) && request.wireBytes !== undefined,
              ),
            }
          : {}),
        requestTimingNote:
          "Raw observations may include post-cutoff completions; requestsAtCutoff strips them. Cutoffs use actual Performance.NavigationStart + same-document performance.now()/1000. Apps' shared qualifier requires a match and all matched start/end residuals <=5ms; no clock adjustment. V8 collection ends at coverageStoppedMs after the DOM cutoff.",
      });
    }
    if (!clockPassed) {
      api.result.dockClockFailure = true;
    }
    const openedIndex = packets.findLastIndex(
      (packet) =>
        packet.id === "first-open" || (id === "browser-focus-existing" && packet.id === "cold"),
    );
    if (api.mode === "coverage" && clockPassed && openedIndex >= 0) {
      state.throughFirstOpen = await api.summarize(
        unionCoverage(
          packets.filter((packet) => packet.id !== "failure").map((packet) => packet.coverage),
        ),
        cutoffRequests[openedIndex]!.filter((request) =>
          /\.m?js$/u.test(new URL(request.url).pathname),
        ),
      );
      state.throughFirstOpenNote =
        "Requested closure at last successful cutoff; unioned interval V8 ranges run until coverageStoppedMs (not atomic at DOM cutoff). Not a timing sample";
    }
  }
  if (api.result.dockClockFailure) {
    throw new Error(
      "Dock clock qualification failed; phase totals withheld and remaining contexts aborted",
    );
  }
}
