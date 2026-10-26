import type { Page } from "playwright";
import type { SessionWorkspaceListResult } from "../../ui/src/api/types.ts";
import { openChatSidePanelType } from "../../ui/src/e2e/chat-side-panel.test-support.ts";
import { openSidebarPages } from "../../ui/src/e2e/sidebar-customization.test-support.ts";
import type { BoardSnapshot } from "../../ui/src/lib/board/types.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { openInteractionPanel } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionFixtureOverrides,
  InteractionSandbox,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const sessionKey = "agent:main:interaction-a";
const tabCount = 4;
const widgetsPerTab = 250;
const galleryCount = 1_000;
const directoryCount = 20;
const filesPerDirectory = 250;
const boardHost = ".chat-pane-cache__pane--active openclaw-board-view";
const workspaceHost = ".workspace-desktop";
const galleryHost = "openclaw-dashboards-page";

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function boardSnapshot(revision = 1): BoardSnapshot {
  return {
    sessionKey,
    revision,
    tabs: Array.from({ length: tabCount }, (_, index) => ({
      tabId: `data-${index}`,
      title: `Data ${index + 1}`,
      position: index,
      chatDock: "right",
    })),
    widgets: Array.from({ length: tabCount * widgetsPerTab }, (_, index) => ({
      name: `data-widget-${index}`,
      tabId: `data-${Math.floor(index / widgetsPerTab)}`,
      title: `Data widget ${index}`,
      contentKind: "plugin",
      pluginKind: "session:report",
      sizeW: 12,
      sizeH: 4,
      heightMode: "fixed",
      position: index % widgetsPerTab,
      grantState: "none",
      revision: index === 0 ? revision : 1,
      props: {
        blocks: [
          {
            type: "metrics",
            items: [{ label: "Completed", value: `${index === 0 ? revision : index}` }],
          },
          {
            type: "chart",
            title: `Throughput ${index}`,
            style: "line",
            points: Array.from({ length: 12 }, (_point, month) => ({
              label: `Month ${month + 1}`,
              value: 10 + ((index + month * 7) % 90),
            })),
          },
        ],
      },
    })),
  };
}

/** Saved core reports exercise the production board without synthetic iframe processes. */
function createDataBoardFixture(_sandbox?: InteractionSandbox): InteractionFixtureOverrides {
  return {
    featureMethods: ["board.get"],
    featureEvents: ["board.changed"],
    controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
    methodResponses: { "board.get": boardSnapshot() },
  };
}

function createGalleryFixture(): InteractionFixtureOverrides {
  const sample = boardSnapshot();
  return {
    ...createDataBoardFixture(),
    sessions: Array.from({ length: galleryCount }, (_, index) => ({
      key: `agent:main:data-gallery-${index}`,
      sessionId: `data-gallery-${index}`,
      kind: "direct",
      agentId: "main",
      boardFace: "dashboard",
      boardPresentation: "expanded",
      hasBoard: true,
      label: `Data dashboard ${String(galleryCount - index - 1).padStart(4, "0")}`,
      displayName: `Data dashboard ${String(galleryCount - index - 1).padStart(4, "0")}`,
      updatedAt: 1_800_000_000_000 - index * 60_000,
      createdActor: { type: "human", id: `author-${index % 10}`, label: `Author ${index % 10}` },
    })),
    methodResponses: {
      // Gallery previews need only one saved widget each; the grid-volume fixture is separate.
      "board.get": {
        cases: Array.from({ length: galleryCount }, (_, index) => ({
          match: { sessionKey: `agent:main:data-gallery-${index}` },
          response: {
            ...sample,
            sessionKey: `agent:main:data-gallery-${index}`,
            tabs: sample.tabs.slice(0, 1),
            widgets: sample.widgets.slice(0, 1),
          },
        })),
      },
    },
  };
}

function directoryPath(index: number) {
  return `package-${String(index).padStart(2, "0")}`;
}

function workspaceListing(path = "", search = ""): SessionWorkspaceListResult {
  const names = Array.from({ length: directoryCount }, (_, index) => directoryPath(index));
  const entries = path
    ? Array.from({ length: filesPerDirectory }, (_, index) => ({
        kind: "file" as const,
        name: `module-${String(index).padStart(3, "0")}.ts`,
        path: `${path}/module-${String(index).padStart(3, "0")}.ts`,
        size: 2_048 + index * 16,
        sessionKind: index % 2 ? ("read" as const) : ("modified" as const),
      }))
    : names.map((name) => ({ kind: "directory" as const, name, path: name }));
  return {
    sessionKey,
    root: "/synthetic/data-pages",
    files: names.flatMap((name) =>
      Array.from({ length: 5 }, (_, index) => ({
        kind: index % 2 ? ("read" as const) : ("modified" as const),
        name: `module-${String(index).padStart(3, "0")}.ts`,
        path: `${name}/module-${String(index).padStart(3, "0")}.ts`,
        workspacePath: `${name}/module-${String(index).padStart(3, "0")}.ts`,
        size: 2_048,
        missing: false,
      })),
    ),
    browser: { path, entries, ...(search ? { search } : {}) },
  };
}

function createWorkspaceFixture(): InteractionFixtureOverrides {
  const query = "module-249";
  return {
    featureMethods: ["sessions.files.list", "artifacts.list"],
    methodResponses: {
      "artifacts.list": { artifacts: [] },
      "sessions.files.list": {
        cases: [
          {
            match: { search: query },
            response: {
              ...workspaceListing("", query),
              browser: {
                path: "",
                search: query,
                entries: Array.from({ length: directoryCount }, (_, index) => ({
                  kind: "file",
                  path: `${directoryPath(index)}/module-249.ts`,
                  name: "module-249.ts",
                  size: 6_032,
                  sessionKind: "read",
                })),
              },
            },
          },
          ...Array.from({ length: directoryCount }, (_, index) => ({
            match: { path: directoryPath(index) },
            response: workspaceListing(directoryPath(index)),
          })),
          { response: workspaceListing() },
        ],
      },
    },
  };
}

async function waitForBoard(page: Page, tab = 0) {
  await page
    .locator(
      `${boardHost} [data-widget-name="data-widget-${tab * widgetsPerTab}"] openclaw-report-widget svg`,
    )
    .waitFor();
  await page.waitForFunction(
    ({ selector, count }) =>
      document.querySelectorAll(`${selector} openclaw-board-widget-cell:not([hidden])`).length ===
      count,
    { selector: boardHost, count: widgetsPerTab },
  );
  await settle(page);
}

async function prepareBoard(page: Page) {
  await openInteractionPanel(page);
  await waitForBoard(page);
}

async function prepareGallery(page: Page) {
  await page.locator(`${galleryHost} [data-dashboard-session]`).first().waitFor();
  await page.waitForFunction(
    ({ selector, count }) =>
      document.querySelectorAll(`${selector} [data-dashboard-session]`).length === count,
    { selector: galleryHost, count: galleryCount },
  );
  await settle(page);
}

async function prepareWorkspace(page: Page) {
  await openChatSidePanelType(page, "Files");
  await page
    .locator(workspaceHost)
    .getByRole("button", { name: directoryPath(0), exact: true })
    .waitFor();
  await settle(page);
}

async function expandWorkspace(page: Page) {
  await prepareWorkspace(page);
  for (let index = 0; index < directoryCount; index++) {
    const path = directoryPath(index);
    await page.locator(workspaceHost).getByRole("button", { name: path, exact: true }).click();
    await page
      .locator(workspaceHost)
      .getByRole("button", { name: `${path}/module-249.ts`, exact: true })
      .waitFor();
  }
  await settle(page);
}

async function scrollSurface(page: Page, selector: string) {
  const before = await page.locator(selector).evaluate((element) => {
    const top = element.scrollTop;
    element.scrollTop = element.scrollHeight;
    return top;
  });
  await settle(page);
  const after = await page.locator(selector).evaluate((element) => element.scrollTop);
  if (after <= before) {
    throw new Error(`Large fixture did not scroll: ${selector}`);
  }
  return { scrollBefore: before, scrollAfter: after };
}

export const dataBoardScenarios: readonly InteractionScenario[] = [
  {
    id: "data-dashboards-first-render",
    dataPage: "dashboards",
    route: "/new",
    expected: "Opening Dashboards presents 1,000 cards with only nearby previews active.",
    fixtureOverrides: createGalleryFixture,
    rowSelector: "[data-dashboard-session]",
    prepare: async (page) => {
      await openSidebarPages(page);
    },
    run: async (page) => {
      await page.getByRole("link", { name: "Dashboards", exact: true }).click();
      await prepareGallery(page);
    },
  },
  {
    id: "data-board-first-render",
    dataPage: "board",
    route: controlUiSessionPath(sessionKey),
    expected: "Opening Dashboard renders 250 saved core reports from a 1,000-widget board.",
    fixtureOverrides: createDataBoardFixture,
    rowSelector: "openclaw-board-widget-cell",
    prepare: async (page) => {
      await page.locator(".chat-thread").first().waitFor();
    },
    run: async (page) => {
      await prepareBoard(page);
      return { visibleWidgets: widgetsPerTab, totalWidgets: tabCount * widgetsPerTab };
    },
  },
  {
    id: "data-board-tab-switch",
    dataPage: "board",
    route: controlUiSessionPath(sessionKey),
    expected: "Switching tabs retains the previous 250 widget instances and presents the next 250.",
    fixtureOverrides: createDataBoardFixture,
    rowSelector: "openclaw-board-widget-cell",
    prepare: prepareBoard,
    run: async (page) => {
      await page.locator(`${boardHost} [data-board-tab-id="data-1"]`).click();
      await waitForBoard(page, 1);
      return { visitedWidgets: widgetsPerTab * 2 };
    },
  },
  {
    id: "data-board-live-update",
    dataPage: "board",
    route: controlUiSessionPath(sessionKey),
    expected: "A board receipt updates one report while preserving all 250 visible widgets.",
    fixtureOverrides: createDataBoardFixture,
    rowSelector: ".board-report__point, .board-report__metrics dd",
    prepare: prepareBoard,
    run: async (page, gateway) => {
      await gateway.setMethodResponse("board.get", boardSnapshot(2));
      await gateway.emitGatewayEvent("board.changed", { sessionKey, revision: 2 });
      await page.waitForFunction(
        (selector) =>
          document.querySelector(
            `${selector} [data-widget-name="data-widget-0"] .board-report__metrics dd`,
          )?.textContent === "2",
        boardHost,
      );
      await settle(page);
    },
  },
  {
    id: "data-board-scroll",
    dataPage: "board",
    route: controlUiSessionPath(sessionKey),
    expected: "Scrolling the 250-widget board preserves its mounted reports.",
    fixtureOverrides: createDataBoardFixture,
    prepare: prepareBoard,
    run: (page) => scrollSurface(page, boardHost),
  },
  {
    id: "data-dashboards-search",
    dataPage: "dashboards",
    route: "/dashboards",
    expected: "Searching 1,000 dashboards returns the one matching title.",
    fixtureOverrides: createGalleryFixture,
    rowSelector: "[data-dashboard-session]",
    prepare: prepareGallery,
    run: async (page) => {
      await page.locator(`${galleryHost} input[type=search]`).fill("Data dashboard 0000");
      await page.locator('[data-dashboard-session="agent:main:data-gallery-999"]').waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-dashboard-session]").length === 1,
      );
      await settle(page);
    },
  },
  {
    id: "data-dashboards-sort",
    dataPage: "dashboards",
    route: "/dashboards",
    expected: "Sorting all 1,000 dashboards preserves their count and title order.",
    fixtureOverrides: createGalleryFixture,
    rowSelector: "[data-dashboard-session]",
    prepare: prepareGallery,
    run: async (page) => {
      await page.locator(`${galleryHost} select`).last().selectOption("title");
      await page.waitForFunction(
        () =>
          document
            .querySelector("[data-dashboard-session]")
            ?.getAttribute("data-dashboard-session") === "agent:main:data-gallery-999",
      );
      await settle(page);
    },
  },
  {
    id: "data-dashboards-scroll",
    dataPage: "dashboards",
    route: "/dashboards",
    expected: "Scrolling reveals the final gallery row and records its preview reads.",
    fixtureOverrides: createGalleryFixture,
    prepare: prepareGallery,
    run: async (page, gateway) => {
      await page
        .locator('[data-dashboard-session="agent:main:data-gallery-999"]')
        .scrollIntoViewIfNeeded();
      await gateway.waitForRequest("board.get", {
        match: { sessionKey: "agent:main:data-gallery-999" },
      });
      await settle(page);
      return { previewReads: (await gateway.getRequests("board.get")).length };
    },
  },
  {
    id: "data-dashboards-responsive-navigation",
    dataPage: "dashboards",
    diagnostic: "Multi-viewport correctness and capture; not a timing comparison.",
    route: "/dashboards",
    expected:
      "All 1,000 titles and links remain native, the final card reveals its content on focus, and 3/2/1-column layouts fit the viewport.",
    fixtureOverrides: createGalleryFixture,
    prepare: prepareGallery,
    run: async (page) => {
      const finalCard = page.locator('[data-dashboard-session="agent:main:data-gallery-999"]');
      const finalLink = finalCard.locator("a.dashboard-card__main");
      const previousLink = page.locator(
        '[data-dashboard-session="agent:main:data-gallery-998"] a.dashboard-card__main',
      );
      const originalLink = await finalLink.elementHandle();
      if (!originalLink) {
        throw new Error("Final dashboard link is missing before scrolling");
      }
      const viewport = page.viewportSize()!;
      try {
        for (const [width, columns] of [
          [1280, 3],
          [900, 2],
          [520, 1],
        ] as const) {
          await page.setViewportSize({ width, height: viewport.height });
          await finalCard.scrollIntoViewIfNeeded();
          await finalLink.focus();
          await finalCard
            .locator(".dashboard-card__author")
            .filter({ hasText: "By Author 9" })
            .waitFor();
          await finalCard
            .locator("openclaw-dashboard-preview openclaw-report-widget svg")
            .waitFor();
          await settle(page);
          if (
            !(await finalLink.evaluate(
              (link, original) => link === original && document.activeElement === original,
              originalLink,
            ))
          ) {
            throw new Error(`Final dashboard link lost identity or native focus at ${width}px`);
          }
          await page.keyboard.press("Shift+Tab");
          if (!(await previousLink.evaluate((link) => document.activeElement === link))) {
            throw new Error(`Shift+Tab did not reach the neighboring dashboard at ${width}px`);
          }
          await page.keyboard.press("Tab");
          if (!(await finalLink.evaluate((link) => document.activeElement === link))) {
            throw new Error(`Tab did not return to the final dashboard at ${width}px`);
          }
          await page
            .locator(`${galleryHost} .dashboards-grid`)
            .evaluate((grid, expectedColumns) => {
              const renderedColumns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
              const bounds = grid.getBoundingClientRect();
              if (
                renderedColumns !== expectedColumns ||
                bounds.left < -1 ||
                bounds.right > innerWidth + 1 ||
                grid.scrollWidth > grid.clientWidth + 1 ||
                document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
              ) {
                throw new Error(
                  `Gallery layout overflows or has ${renderedColumns} columns, expected ${expectedColumns}`,
                );
              }
            }, columns);
          const counts = await page.locator(galleryHost).evaluate((host) => ({
            cards: host.querySelectorAll("[data-dashboard-session]").length,
            links: host.querySelectorAll("[data-dashboard-session] a.dashboard-card__main").length,
            titles: host.querySelectorAll("[data-dashboard-session] h2").length,
          }));
          if (Object.values(counts).some((count) => count !== galleryCount)) {
            throw new Error(`Gallery lost native cards, titles or links at ${width}px`);
          }
        }
        return { cards: galleryCount, responsiveLayouts: 3, retainedFinalLink: true };
      } finally {
        await page.setViewportSize(viewport);
        await originalLink.dispose();
      }
    },
  },
  {
    id: "data-workspace-first-render",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected:
      "Opening Files presents 20 folders and 100 touched files without reading descendants.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row",
    prepare: async (page) => {
      await page.locator(".chat-thread").first().waitFor();
    },
    run: async (page) => {
      await prepareWorkspace(page);
    },
  },
  {
    id: "data-workspace-expand",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected: "Expanding the last folder in a 5,000-file loaded tree presents its 250 children.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row",
    prepare: async (page) => {
      await expandWorkspace(page);
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: directoryPath(19), exact: true })
        .click();
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: `${directoryPath(19)}/module-249.ts`, exact: true })
        .waitFor({ state: "detached" });
      await settle(page);
    },
    run: async (page) => {
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: directoryPath(19), exact: true })
        .click();
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: `${directoryPath(19)}/module-249.ts`, exact: true })
        .waitFor();
      await settle(page);
    },
  },
  {
    id: "data-workspace-search",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected: "Searching a 5,000-file loaded tree presents the 20 authoritative matching results.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row",
    prepare: expandWorkspace,
    run: async (page) => {
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: "Search files", exact: true })
        .click();
      await page.locator(workspaceHost).getByRole("searchbox").fill("module-249");
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".workspace-desktop__results .workspace-desktop__row")
            .length === 20,
      );
      await settle(page);
    },
  },
  {
    id: "data-workspace-scroll",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected: "The 5,000-file expanded tree scrolls within the Files panel.",
    fixtureOverrides: createWorkspaceFixture,
    prepare: expandWorkspace,
    run: (page) => scrollSurface(page, `${workspaceHost} .workspace-desktop__project-scroll`),
  },
  {
    id: "data-workspace-filter",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected: "Filtering 5,000 files to Changed retains only modified files and their folders.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row",
    prepare: expandWorkspace,
    run: async (page) => {
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: "Filter files: All", exact: true })
        .click();
      await page.getByRole("menuitemradio", { name: "Changed", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".workspace-desktop__project-scroll .workspace-desktop__row")
            .length === 2_520,
      );
      await settle(page);
    },
  },
];
