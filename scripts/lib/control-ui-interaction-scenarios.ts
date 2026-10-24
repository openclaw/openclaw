import type { Locator, Page } from "playwright";
import type { ConfigSchemaResponse, CronJob } from "../../ui/src/api/types.ts";
import { pathForAgentPanel, pathForRoute } from "../../ui/src/app-route-paths.ts";
import { createSkill } from "../../ui/src/pages/skills/view.test-support.ts";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  controlUiSessionPath,
  type ControlUiMockGatewayScenario,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../../ui/src/test-helpers/control-ui-navigation.ts";
import { cronListResponseFixture } from "../../ui/src/test-helpers/cron.ts";
import { meetingStatus } from "../../ui/src/test-helpers/transcripts.test-support.ts";

const sessionKeys = ["agent:main:interaction-a", "agent:main:interaction-b"] as const;
const sessionQuery = "Interaction 0999";
const modelQuery = "Warm model 0999";
const cronQuery = "Warm automation 0499";
const activePane = ".chat-pane-cache__pane--active";

export type InteractionScenario = {
  id: string;
  route: string;
  expected: string;
  /** Count newly inserted rows across the action, including transient replacements. */
  rowSelector?: string;
  prepare: (page: Page, gateway: MockGatewayControls) => Promise<void>;
  run: (page: Page, gateway: MockGatewayControls) => Promise<void>;
};

export function createInteractionFixture(buildId: string, version: string) {
  const captureSources = ["Alpha", "Beta"].map((title) => ({
    providerId: "test-voice",
    guildId: "guild",
    channelId: title.toLowerCase(),
    title,
  }));
  const config = { transcripts: { enabled: true, autoStart: captureSources } };
  const sessions = Array.from({ length: 1_000 }, (_, index) => ({
    key: sessionKeys[index] ?? `agent:main:interaction-${index}`,
    sessionId: `interaction-session-${index}`,
    agentId: "main",
    kind: "direct" as const,
    label: `Interaction ${String(index).padStart(4, "0")}`,
    updatedAt: 1_800_000_000_000 - index * 1_000,
    childOwnerSessionKeys: [],
  }));
  const jobs: CronJob[] = Array.from({ length: 500 }, (_, index) => ({
    id: `interaction-job-${index}`,
    name: `Warm automation ${String(index).padStart(4, "0")}`,
    enabled: true,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Synthetic interaction benchmark reminder." },
    state: {},
  }));
  const cronPage = (rows: CronJob[], offset: number) => ({
    jobs: rows.slice(offset, offset + 50),
    snapshotRevision: "interaction-cron-inventory",
    total: rows.length,
    offset,
    limit: 50,
    hasMore: offset + 50 < rows.length,
    nextOffset: offset + 50 < rows.length ? offset + 50 : null,
  });
  const cronCases = Array.from({ length: cronQuery.length }, (_, index) => {
    const query = cronQuery.slice(0, index + 1);
    return {
      match: { query },
      response: cronPage(
        jobs.filter((job) => job.name.includes(query)),
        0,
      ),
    };
  });
  return {
    serverBuildId: buildId,
    serverVersion: version,
    sessionKey: sessionKeys[0],
    agentModel: "example/model-0",
    sessions,
    sessionTranscripts: Object.fromEntries(
      sessionKeys.map((key, sessionIndex) => [
        key,
        {
          messages: Array.from({ length: 400 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `Transcript ${sessionIndex} message ${index}.\n${"Synthetic transcript detail.\n".repeat(4)}`,
            timestamp: 1_800_000_000_000 + index * 1_000,
            __openclaw: { id: `interaction-${sessionIndex}-${index}`, seq: index + 1 },
          })),
        },
      ]),
    ),
    models: Array.from({ length: 1_000 }, (_, index) => ({
      id: `model-${index}`,
      name: `Warm model ${String(index).padStart(4, "0")}`,
      provider: "example",
      contextWindow: 128_000,
    })),
    methodResponses: {
      "config.schema": {
        schema: { type: "object", properties: {} },
        uiHints: {},
        version: "interaction-config",
        generatedAt: "2026-10-23T00:00:00.000Z",
      } satisfies ConfigSchemaResponse,
      "progressCard.get": { card: null },
      "config.get": {
        config,
        sourceConfig: config,
        hash: "interaction-config",
        raw: JSON.stringify(config),
        valid: true,
        issues: [],
      },
      "transcripts.status": {
        ...meetingStatus,
        configuredSources: captureSources.map((source) =>
          Object.assign({}, meetingStatus.configuredSources[0], { source, title: source.title }),
        ),
      },
      "skills.status": {
        workspaceDir: "/synthetic/workspace",
        managedSkillsDir: "/synthetic/skills",
        skills: ["Alpha", "Beta"].map((name) =>
          createSkill({
            name,
            skillKey: name.toLowerCase(),
            primaryEnv: undefined,
            missing: { bins: ["synthetic-bin"], anyBins: [], env: [], config: [], os: [] },
            blockedByAgentFilter: true,
          }),
        ),
      },
      "sessions.storage.status": {
        agents: ["main", "research"].map((agentId) => ({
          agentId,
          storePath: `/synthetic/${agentId}.sqlite`,
          hotTranscripts: 7,
          coldTranscripts: 0,
          databaseBytes: 4096,
          walBytes: 0,
          archiveBytes: 0,
          embeddedArchiveBytes: 0,
        })),
        maintenance: {
          running: false,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastError: null,
          archivedTranscripts: 0,
          externalizedTranscripts: 0,
        },
      },
      "models.authStatus": {
        ts: 1_800_000_000_000,
        providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles: [] }],
      },
      "usage.status": {
        updatedAt: 1_800_000_000_000,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [
              { label: "5h", usedPercent: 25 },
              { label: "Weekly", usedPercent: 40 },
            ],
            billing: [{ type: "balance", amount: 12, unit: "credits" }],
          },
        ],
      },
      "cron.list": cronListResponseFixture([
        ...cronCases,
        ...Array.from({ length: 10 }, (_, index) => ({
          match: { offset: index * 50 },
          response: cronPage(jobs, index * 50),
        })),
        { response: cronPage(jobs, 0) },
      ]),
      "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
      "cron.runs": {
        entries: [],
        total: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },
    },
  } satisfies ControlUiMockGatewayScenario;
}

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function inViewport(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box || (await locator.evaluate((element) => element.closest("[inert]") !== null))) {
    return false;
  }
  const viewport = await locator
    .page()
    .evaluate(() => ({ width: innerWidth, height: innerHeight }));
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y < viewport.height;
}

async function openNavigationDrawer(page: Page) {
  const chatToggle = page.locator(`${activePane} .mobile-header__navigation`);
  await ((await chatToggle.count()) > 0 ? chatToggle : navigationDrawerToggle(page)).click();
  const drawer = page.locator(".shell--nav-drawer-open > .shell-nav");
  await drawer.waitFor({ state: "visible" });
  await drawer.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
}

async function navigation(page: Page, view: "pages" | "sessions") {
  const button = page.locator(`[data-navigation-view="${view}"]`).first();
  if (!(await inViewport(button))) {
    await openNavigationDrawer(page);
  }
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
  }
  await page
    .locator(view === "pages" ? ".sidebar-pages" : ".sidebar-recent-session")
    .first()
    .waitFor();
}

async function switchSession(page: Page, index: 0 | 1) {
  await navigation(page, "sessions");
  await page
    .locator(
      `.sidebar-recent-session[data-session-key="${sessionKeys[index]}"] .sidebar-recent-session__link`,
    )
    .click();
  await page
    .locator(activePane)
    .getByText(`Transcript ${index} message 399.`, { exact: false })
    .waitFor();
  await frames(page);
}

async function prepareChat(page: Page) {
  await page.locator(activePane).getByText("Transcript 0 message 399.", { exact: false }).waitFor();
  await frames(page);
}

async function prepareSessionSwitch(page: Page) {
  await prepareChat(page);
  await switchSession(page, 1);
  await switchSession(page, 0);
}

async function routeLink(page: Page, route: "sessions" | "cron") {
  await navigation(page, "pages");
  return page.locator(`.sidebar-pages a[href="${pathForRoute(route)}"]`).first();
}

async function inventoryReady(
  page: Page,
  gateway: MockGatewayControls,
  route: "sessions" | "cron",
) {
  if (route === "sessions") {
    await gateway.waitForRequest("sessions.list", { match: { source: "sessions-page" } });
    await page
      .locator(".sessions-table tbody .session-data-row")
      .first()
      .getByText("Interaction 0000", { exact: true })
      .waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll(".sessions-table tbody .session-data-row").length === 25,
    );
  } else {
    await gateway.waitForRequest("cron.list", { match: { offset: 0 } });
    await page
      .locator(".cron-table__row")
      .getByText("Warm automation 0000", { exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".cron-table__row").length === 50 &&
        document.querySelector(".cron-table")?.getAttribute("aria-busy") !== "true",
    );
  }
}

async function warmRoute(page: Page, gateway: MockGatewayControls, route: "sessions" | "cron") {
  await (await routeLink(page, route)).click();
  await waitForControlUiRoute(page, { routeId: route });
  await inventoryReady(page, gateway, route);
  await page.goBack();
  await waitForControlUiRoute(page, { routeId: "new-session" });
  await (await routeLink(page, route)).waitFor();
}

async function prepareSessions(page: Page, gateway: MockGatewayControls) {
  await page.locator(".sessions-table tbody .session-data-row").first().waitFor();
  const toggle = page.getByRole("button", { name: "Filters", exact: true });
  await toggle.click();
  const filters = page.locator(".sessions-filter-popover:popover-open");
  const after = (
    await gateway.getRequests("sessions.list", { source: "sessions-page", limit: 1000 })
  ).length;
  const limit = filters.getByLabel("Limit", { exact: true });
  await limit.fill("1000");
  await limit.press("Tab");
  await gateway.waitForRequest("sessions.list", {
    after,
    match: { source: "sessions-page", limit: 1000 },
  });
  await page.locator(".data-table-pagination__info").getByText(/1000/).waitFor();
  await toggle.click();
  await filters.waitFor({ state: "hidden" });
  // The owner sorts 1,000 rows, while the product deliberately renders at most 100 per page.
  await page.locator(".data-table-pagination__size").selectOption("100");
  await page.waitForFunction(
    () => document.querySelectorAll(".sessions-table tbody .session-data-row").length === 100,
  );
  await frames(page);
}

async function refreshSessions(page: Page, gateway: MockGatewayControls) {
  const after = (await gateway.getRequests("sessions.list", { source: "sessions-page" })).length;
  await page.locator(".sessions-toolbar__refresh").click();
  await gateway.waitForRequest("sessions.list", { after, match: { source: "sessions-page" } });
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>(".sessions-toolbar__refresh")?.disabled,
  );
  await frames(page);
}

async function prepareCron(page: Page) {
  await page.locator(".cron-table__row").first().waitFor();
  const more = page.getByRole("button", { name: "Load more", exact: true });
  for (let count = 100; count <= 500; count += 50) {
    await more.click();
    await page.waitForFunction(
      (expected) => document.querySelectorAll(".cron-table__row").length === expected,
      count,
    );
  }
}

async function settingsSection(
  page: Page,
  path: string,
  routeId: "appearance" | "connection" | "notifications",
) {
  const sidebar = page.locator(".settings-sidebar");
  await sidebar.waitFor({ state: "attached" });
  if (!(await inViewport(sidebar))) {
    await openNavigationDrawer(page);
  }
  await sidebar.locator(`a[href="${path}"]`).click();
  await waitForControlUiRoute(page, { routeId, pathname: path });
}

async function prepareModelPicker(page: Page) {
  await prepareChat(page);
  await page.locator(`${activePane} .agent-chat__input textarea`).first().click();
  const trigger = page.locator(`${activePane} [data-chat-model-select]`);
  await trigger.waitFor({ state: "visible" });
  await trigger.click();
  await page.locator("[data-chat-model-search]").waitFor();
  await trigger.click();
}

async function searchModels(page: Page) {
  await page.locator("[data-chat-model-search]").pressSequentially(modelQuery);
  await page.locator('[data-chat-model-option="example/model-999"]').waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLElement>("[data-chat-model-option]")].filter((option) =>
        option.checkVisibility(),
      ).length === 1,
  );
}

export const interactionScenarios: readonly InteractionScenario[] = [
  {
    id: "agent-skills-refresh",
    route: pathForAgentPanel("main", "skills"),
    expected: "Refreshing the agent's skills retains both rows and their diagnostics.",
    rowSelector: ".agent-skill-row, .agent-skill-row .settings-row__desc",
    prepare: async (page) => {
      await page.locator(".agent-skill-row").first().waitFor();
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("skills.status")).length;
      const section = page.locator(".settings-section").filter({
        has: page.locator('input[name="agent-skills-filter"]'),
      });
      await section.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("skills.status", { after });
      await frames(page);
    },
  },
  {
    id: "meeting-health-refresh",
    route: `${pathForRoute("communications")}?section=transcripts#settings-communications-meeting-capture`,
    expected: "Refreshing capture health retains source controls and health rows.",
    rowSelector: "openclaw-meeting-capture-settings .settings-row",
    prepare: async (page) => {
      await page
        .locator('openclaw-meeting-capture-settings [aria-label="Edit source 1"]')
        .waitFor();
      await page.getByText("Applied source state", { exact: true }).waitFor();
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("transcripts.status")).length;
      await page
        .locator("openclaw-meeting-capture-settings")
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await gateway.waitForRequest("transcripts.status", { after });
      await frames(page);
    },
  },
  {
    id: "cron-refresh",
    route: pathForRoute("cron"),
    expected: "Refreshing the first automation page retains unchanged job rows.",
    rowSelector: ".cron-table__row",
    prepare: async (page, gateway) => inventoryReady(page, gateway, "cron"),
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("cron.list")).length;
      await page.locator(".cron-refresh").click();
      await gateway.waitForRequest("cron.list", { after });
      await page.waitForFunction(
        () => document.querySelector(".cron-table")?.getAttribute("aria-busy") !== "true",
      );
      await frames(page);
    },
  },
  {
    id: "provider-usage-refresh",
    route: pathForRoute("model-providers"),
    expected: "Refreshing provider usage retains the plan windows and billing rows.",
    rowSelector:
      ".provider-usage__group, .provider-usage__window, .provider-usage__row, .provider-usage__chip",
    prepare: async (page) => {
      const summary = page.locator('[data-provider-id="openai"] .provider-row__summary');
      await summary.waitFor();
      if ((await summary.getAttribute("aria-expanded")) !== "true") {
        await summary.click();
      }
      await page.locator(".provider-usage__window").first().waitFor();
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("usage.status")).length;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("usage.status", { after });
      await frames(page);
    },
  },
  {
    id: "storage-refresh",
    route: `${pathForRoute("ai-agents")}?section=session#settings-session-storage`,
    expected: "An unchanged storage refresh retains both agent rows and the open disclosure.",
    rowSelector: "openclaw-session-storage-settings details > .settings-row",
    prepare: async (page) => {
      const details = page.locator(
        "openclaw-session-storage-settings details.settings-row--stacked",
      );
      await details.locator("summary").click();
      await details.getByText("research", { exact: true }).waitFor();
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("sessions.storage.status")).length;
      const section = page.locator("openclaw-session-storage-settings");
      await section.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("sessions.storage.status", { after });
      await section.getByRole("button", { name: "Refresh", exact: true }).waitFor();
      await frames(page);
    },
  },
  {
    id: "sessions-refresh",
    route: pathForRoute("sessions"),
    expected: "Refreshing retains all visible sessions and expanded detail statistics.",
    rowSelector: ".sessions-table .session-data-row, .session-detail-stat",
    prepare: async (page, gateway) => {
      await prepareSessions(page, gateway);
      await refreshSessions(page, gateway);
      await page.locator(".session-details-toggle").first().click();
      await page.locator(".session-detail-stat").first().waitFor();
    },
    run: refreshSessions,
  },
  {
    id: "session-switch",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "Both retained 400-message transcripts become visible in turn.",
    rowSelector: "[data-virtual-row-key], .sidebar-recent-session",
    prepare: prepareSessionSwitch,
    run: async (page) => {
      await switchSession(page, 1);
      await switchSession(page, 0);
    },
  },
  {
    id: "transcript-scroll-top",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The first message of the 400-message transcript enters the viewport.",
    prepare: prepareChat,
    run: async (page) => {
      const thread = page.locator(`${activePane} .chat-thread`);
      await thread.hover();
      await page.mouse.wheel(0, -(await thread.evaluate((element) => element.scrollHeight)));
      await thread.getByText("Transcript 0 message 0.", { exact: false }).waitFor();
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.scrollTop === 0,
        `${activePane} .chat-thread`,
      );
      await frames(page);
    },
  },
  {
    id: "sidebar-toggle",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The 1,000-session sidebar closes and reopens.",
    prepare: async (page, gateway) => {
      await prepareChat(page);
      await navigation(page, "sessions");
      const more = page.locator(
        ".sidebar-session-pagination--roster > .sidebar-session-pagination__button",
      );
      for (const offset of [200, 400, 600, 800]) {
        await more.click();
        await gateway.waitForRequest("sessions.list", {
          match: { source: "sidebar", offset, limit: 200 },
        });
        await frames(page);
      }
      await more.waitFor({ state: "hidden" });
    },
    run: async (page) => {
      if (await page.locator(".shell--mobile-nav").count()) {
        await page.keyboard.press("Escape");
        await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
      } else {
        await page.locator(".sidebar-session-toolbar__collapse").first().click();
      }
      await navigation(page, "sessions");
      await page.locator(`.sidebar-recent-session[data-session-key="${sessionKeys[0]}"]`).waitFor();
      await frames(page);
    },
  },
  {
    id: "session-palette-filter",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The command palette filters the session catalog to Interaction 0999.",
    prepare: async (page) => {
      await prepareChat(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.locator(".cmd-palette__input").waitFor();
      await page.keyboard.press("Escape");
    },
    run: async (page, gateway) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.locator(".cmd-palette__input").pressSequentially(sessionQuery);
      await page.getByRole("option", { name: new RegExp(sessionQuery) }).waitFor();
      await gateway.waitForRequest("sessions.search", { match: { query: sessionQuery } });
    },
  },
  {
    id: "settings-open",
    route: "/new",
    expected: "Settings opens at Appearance with a usable settings sidebar.",
    prepare: async (page) => {
      await page.keyboard.press("ControlOrMeta+Shift+,");
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await page.keyboard.press("Escape");
      await waitForControlUiRoute(page, { routeId: "new-session" });
    },
    run: async (page, gateway) => {
      const schemaReads = (await gateway.getRequests("config.schema")).length;
      await page.keyboard.press("ControlOrMeta+Shift+,");
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await page.locator(".settings-page").waitFor();
      await frames(page);
      if ((await gateway.getRequests("config.schema")).length !== schemaReads) {
        throw new Error("Warm Settings must retain the loaded config schema");
      }
    },
  },
  {
    id: "settings-sections",
    route: "/settings/appearance",
    expected: "Notifications, Connection, and Appearance each finish their warm route transition.",
    prepare: async (page) => {
      await settingsSection(page, "/settings/notifications", "notifications");
      await settingsSection(page, "/settings/connection", "connection");
      await settingsSection(page, "/settings/appearance", "appearance");
    },
    run: async (page, gateway) => {
      const schemaReads = (await gateway.getRequests("config.schema")).length;
      await settingsSection(page, "/settings/notifications", "notifications");
      await settingsSection(page, "/settings/connection", "connection");
      await settingsSection(page, "/settings/appearance", "appearance");
      await frames(page);
      if ((await gateway.getRequests("config.schema")).length !== schemaReads) {
        throw new Error("Warm Settings tabs must retain the loaded config schema");
      }
    },
  },
  {
    id: "model-picker-open-search",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The 1,000-model picker opens and filters to Warm model 0999.",
    prepare: prepareModelPicker,
    run: async (page) => {
      await page.locator(`${activePane} [data-chat-model-select]`).click();
      await searchModels(page);
    },
  },
  {
    id: "model-picker-search",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The already-open 1,000-model picker filters to Warm model 0999.",
    prepare: async (page) => {
      await prepareModelPicker(page);
      await page.locator(`${activePane} [data-chat-model-select]`).click();
      await page.locator("[data-chat-model-search]").waitFor();
      await frames(page);
    },
    run: searchModels,
  },
  ...(["sessions", "cron"] as const).map((route): InteractionScenario => ({
    id: `${route}-open`,
    route: "/new",
    expected: `The warm ${route} route opens its default window from the Pages navigation.`,
    prepare: async (page, gateway) => warmRoute(page, gateway, route),
    run: async (page, gateway) => {
      await (await routeLink(page, route)).click();
      await waitForControlUiRoute(page, { routeId: route });
      await inventoryReady(page, gateway, route);
    },
  })),
  {
    id: "sessions-sort",
    route: "/sessions",
    expected: "Sorting the 1,000-session result reverses its Updated order.",
    prepare: prepareSessions,
    run: async (page) => {
      await page
        .locator(".sessions-table")
        .getByRole("button", { name: "Updated", exact: true })
        .click();
      await page
        .locator(".sessions-table tbody .session-data-row")
        .first()
        .getByText(sessionQuery, { exact: true })
        .waitFor();
    },
  },
  {
    id: "sessions-search",
    route: "/sessions",
    expected: "Gateway filtering replaces the 1,000-session result with Interaction 0999.",
    prepare: prepareSessions,
    run: async (page, gateway) => {
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      const after = (await gateway.getRequests("sessions.list", { search: sessionQuery })).length;
      await page
        .locator(".sessions-filter-popover:popover-open input")
        .first()
        .pressSequentially(sessionQuery);
      await gateway.waitForRequest("sessions.list", { after, match: { search: sessionQuery } });
      await page
        .locator(".sessions-table tbody .session-data-row")
        .getByText(sessionQuery, { exact: true })
        .waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll(".sessions-table tbody .session-data-row").length === 1,
      );
    },
  },
  {
    id: "cron-search-typing-pending",
    route: pathForRoute("cron"),
    expected: "Typing updates the filter while one held request retains all 500 jobs.",
    prepare: async (page, gateway) => {
      await prepareCron(page);
      await page.getByRole("searchbox", { name: "Search automations" }).click();
      await gateway.deferNext("cron.list");
    },
    run: async (page, gateway) => {
      const before = (await gateway.getRequests("cron.list")).length;
      const search = page.getByRole("searchbox", { name: "Search automations" });
      await search.pressSequentially(cronQuery);
      await gateway.waitForRequest("cron.list", { match: { query: "W", offset: 0 } });
      await frames(page);
      if (
        (await search.inputValue()) !== cronQuery ||
        (await page.locator(".cron-table__row").count()) !== 500 ||
        (await page.locator(".cron-table").getAttribute("aria-busy")) !== "true" ||
        (await gateway.getRequests("cron.list")).length - before !== 1
      ) {
        throw new Error("Expected the typed filter and 500 retained rows with one pending request");
      }
    },
  },
  {
    id: "cron-menu-open",
    route: pathForRoute("cron"),
    expected: "The first of 500 jobs opens its enabled Run if due, Clone, and Remove actions.",
    prepare: prepareCron,
    run: async (page) => {
      const trigger = page.locator(".cron-table__row").first().locator(".cron-job-menu__trigger");
      const menuId = await trigger.getAttribute("aria-controls");
      if (!menuId) {
        throw new Error("Automation action trigger has no menu target");
      }
      await trigger.click();
      const menu = page.locator(`[id=${JSON.stringify(menuId)}][role="menu"]`);
      await menu.waitFor({ state: "visible" });
      for (const name of ["Run if due", "Clone", "Remove"]) {
        const item = menu.getByRole("menuitem", { name, exact: true });
        await item.waitFor({ state: "visible" });
        if (!(await item.isEnabled())) {
          throw new Error(`Automation action is disabled: ${name}`);
        }
      }
      if ((await menu.getByRole("menuitem").count()) !== 3) {
        throw new Error("Expected exactly three automation menu actions");
      }
    },
  },
  ...(["paste", "typing"] as const).map((input): InteractionScenario => ({
    id: input === "paste" ? "cron-search" : "cron-search-typing",
    route: pathForRoute("cron"),
    expected: `${input === "paste" ? "Pasting" : "Typing"} a filter replaces 500 loaded jobs with Warm automation 0499.`,
    prepare: prepareCron,
    run: async (page, gateway) => {
      const requestsBefore = (await gateway.getRequests("cron.list")).length;
      const after = (await gateway.getRequests("cron.list", { query: cronQuery })).length;
      // A single input keeps request coalescing from changing the workload across builds.
      const search = page.getByRole("searchbox", { name: "Search automations" });
      if (input === "paste") {
        await search.fill(cronQuery);
      } else {
        await search.pressSequentially(cronQuery);
      }
      await gateway.waitForRequest("cron.list", { after, match: { query: cronQuery, offset: 0 } });
      await page.locator(".cron-table__row").getByText(cronQuery, { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll(".cron-table__row").length === 1);
      if (
        input === "paste" &&
        (await gateway.getRequests("cron.list")).length - requestsBefore !== 1
      ) {
        throw new Error("Expected exactly one automation filter request");
      }
    },
  })),
];
