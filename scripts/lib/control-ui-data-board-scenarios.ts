import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import type {
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
} from "../../ui/src/api/types.ts";
import { openChatSidePanelType } from "../../ui/src/e2e/chat-side-panel.test-support.ts";
import { openSidebarPages } from "../../ui/src/e2e/sidebar-customization.test-support.ts";
import type { BoardSnapshot } from "../../ui/src/lib/board/types.ts";
import {
  controlUiSessionPath,
  type MockGatewayControls,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
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
const workspaceRoot = "/synthetic/data-pages";
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
    root: workspaceRoot,
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

function workspaceSearchListing(): SessionWorkspaceListResult {
  const query = "module-249";
  return {
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
            response: workspaceSearchListing(),
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

function createWorkspaceNavigationFixture(): InteractionFixtureOverrides {
  const fixture = createWorkspaceFixture();
  const path = `${directoryPath(19)}/module-249.ts`;
  const file: SessionWorkspaceGetResult = {
    sessionKey,
    root: workspaceRoot,
    file: {
      kind: "read",
      name: "module-249.ts",
      path,
      workspacePath: path,
      size: 48,
      missing: false,
      previewKind: "text",
      contentEncoding: "utf8",
      content: "// Synthetic workspace navigation proof.\n",
    },
  };
  return {
    ...fixture,
    featureMethods: [...(fixture.featureMethods ?? []), "sessions.files.get"],
    methodResponses: {
      ...fixture.methodResponses,
      "sessions.files.get": {
        cases: [{ match: { sessionKey, path: `${workspaceRoot}/${path}` }, response: file }],
      },
    },
  };
}

async function assertWorkspacePopulation(gateway: MockGatewayControls) {
  const requests = await gateway.getRequests("sessions.files.list", { sessionKey });
  const paths = new Set(
    requests.flatMap(({ params }) =>
      isRecord(params) && !params.search && typeof params.path === "string" ? [params.path] : [],
    ),
  );
  const expected = Array.from({ length: directoryCount }, (_, index) => directoryPath(index));
  if (expected.some((path) => !paths.has(path))) {
    throw new Error("Workspace fixture did not request all 20 directory listings");
  }
  // These are the exact fixture responses requested through the production owner,
  // not a count of mounted rows. Endpoint assertions below verify their presentation.
  return {
    requestedFolders: expected.length,
    requestedFixtureFiles: expected.reduce(
      (count, path) => count + (workspaceListing(path).browser?.entries.length ?? 0),
      0,
    ),
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

async function settleWorkspace(page: Page) {
  await settle(page);
  await page.locator(workspaceHost).evaluate(async (element) => {
    await Promise.allSettled(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  await settle(page);
}

async function expandWorkspace(page: Page, gateway: MockGatewayControls) {
  await prepareWorkspace(page);
  for (let index = 0; index < directoryCount; index++) {
    const path = directoryPath(index);
    // Keyboard setup skips disclosure animation; measured expansion still clicks.
    await page.locator(workspaceHost).getByRole("button", { name: path, exact: true }).focus();
    await page.keyboard.press("Enter");
    await page
      .locator(workspaceHost)
      .getByRole("button", { name: `${path}/module-249.ts`, exact: true })
      .waitFor();
    await settleWorkspace(page);
  }
  await assertWorkspacePopulation(gateway);
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

function workspaceInitialScenario(roundTripMs: 0 | 100): InteractionScenario {
  return {
    id: `data-workspace-first-render${roundTripMs ? "-100ms" : ""}`,
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected:
      "Opening Files reads one root listing; desktop shows its 20 folders and mobile shows touched files.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row",
    createRequestHandlers: roundTripMs
      ? () => ({
          "sessions.files.list": async (params: unknown) => {
            if (
              !isRecord(params) ||
              params.sessionKey !== sessionKey ||
              params.path !== "" ||
              params.search !== ""
            ) {
              throw new Error("Expected one Workspace root-listing request");
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, roundTripMs);
            });
            return workspaceListing();
          },
        })
      : undefined,
    prepare: async (page, gateway) => {
      await page.locator(".chat-thread").first().waitFor();
      if ((await gateway.getRequests("sessions.files.list", { sessionKey })).length !== 0) {
        throw new Error("Workspace initial-load fixture was already fetched before opening Files");
      }
    },
    run: async (page, gateway) => {
      const mobile = await page.locator(".agent-chat__header--mobile").isVisible();
      if (mobile) {
        await openChatSidePanelType(page, "Files");
        await page
          .locator(".chat-workspace-mobile")
          .getByRole("button", { name: "package-00/module-000.ts", exact: true })
          .waitFor();
      } else {
        await prepareWorkspace(page);
      }
      const requests = await gateway.getRequests("sessions.files.list", { sessionKey });
      const first = requests[0];
      if (
        requests.length !== 1 ||
        !first ||
        !isRecord(first.params) ||
        first.params.path !== "" ||
        first.params.search !== ""
      ) {
        throw new Error("Workspace initial load did not use exactly one root listing");
      }
      if (!mobile) {
        await page.waitForFunction(
          ({ selector, count }) => {
            const folders = [
              ...document.querySelectorAll(
                `${selector} .workspace-desktop__project-scroll .workspace-desktop__row[aria-expanded]`,
              ),
            ];
            return (
              folders.length === count &&
              folders.every(
                (folder, index) =>
                  folder.getAttribute("aria-label") === `package-${String(index).padStart(2, "0")}`,
              )
            );
          },
          { selector: workspaceHost, count: directoryCount },
        );
      }
      return {
        rootListingRequests: requests.length,
        rootListingRoundTripMs: roundTripMs,
        initialFolders: mobile ? 0 : directoryCount,
        rootResponseTouchedFiles: directoryCount * 5,
        descendantListingRequests: 0,
      };
    },
  };
}

function workspaceSearchScenario(roundTripMs: 0 | 100): InteractionScenario {
  return {
    id: roundTripMs ? "data-workspace-search-100ms" : "data-workspace-search",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected: "Searching a 5,000-file loaded tree presents the 20 authoritative matching results.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row",
    prepare: expandWorkspace,
    createRequestHandlers: roundTripMs
      ? () => ({
          "sessions.files.list": async (params) => {
            if (isRecord(params) && params.search === "module-249") {
              // Only this search RPC receives simulated RTT, not folder reads or assets.
              await new Promise<void>((resolve) => {
                setTimeout(resolve, roundTripMs);
              });
              return workspaceSearchListing();
            }
            // A handler replaces every static response for this method, including setup reads.
            const path = isRecord(params) && typeof params.path === "string" ? params.path : "";
            const listedPath = Array.from({ length: directoryCount }, (_, index) =>
              directoryPath(index),
            ).find((candidate) => candidate === path);
            return workspaceListing(listedPath);
          },
        })
      : undefined,
    run: async (page, gateway) => {
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: "Search files", exact: true })
        .click();
      await page.locator(workspaceHost).getByRole("searchbox").fill("module-249");
      await gateway.waitForRequest("sessions.files.list", {
        match: { sessionKey, search: "module-249" },
      });
      await page.waitForFunction(
        ({ selector, expectedPaths }) => {
          const paths = Array.from(
            document.querySelectorAll(
              `${selector} .workspace-desktop__results .workspace-desktop__row`,
            ),
            (row) => row.getAttribute("aria-label"),
          );
          return (
            paths.length === expectedPaths.length &&
            expectedPaths.every((path) => paths.includes(path))
          );
        },
        {
          selector: workspaceHost,
          expectedPaths: Array.from(
            { length: directoryCount },
            (_, index) => `${directoryPath(index)}/module-249.ts`,
          ),
        },
      );
      await settle(page);
    },
  };
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
  workspaceInitialScenario(0),
  workspaceInitialScenario(100),
  {
    id: "data-workspace-expand",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected: "Expanding the last folder in a 5,000-file loaded tree presents its 250 children.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row",
    prepare: async (page, gateway) => {
      await expandWorkspace(page, gateway);
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: directoryPath(19), exact: true })
        .click();
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: `${directoryPath(19)}/module-249.ts`, exact: true })
        .waitFor({ state: "detached" });
      await settleWorkspace(page);
      await page
        .locator(`${workspaceHost} .workspace-desktop__project-scroll`)
        .evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
      await settleWorkspace(page);
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
      await settleWorkspace(page);
    },
  },
  workspaceSearchScenario(0),
  workspaceSearchScenario(100),
  {
    id: "data-workspace-scroll",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected: "The 5,000-file expanded tree scrolls within the Files panel.",
    fixtureOverrides: createWorkspaceFixture,
    prepare: expandWorkspace,
    run: async (page) => {
      const scroll = await scrollSurface(
        page,
        `${workspaceHost} .workspace-desktop__project-scroll`,
      );
      await page.waitForFunction(
        ({ selector, path }) => {
          const scroller = document.querySelector(`${selector} .workspace-desktop__project-scroll`);
          const row = scroller?.querySelector(`[aria-label="${path}"]`);
          if (!scroller || !row) {
            return false;
          }
          const viewport = scroller.getBoundingClientRect();
          const bounds = row.getBoundingClientRect();
          return bounds.height > 0 && bounds.top < viewport.bottom && bounds.bottom > viewport.top;
        },
        { selector: workspaceHost, path: `${directoryPath(19)}/module-249.ts` },
      );
      return { ...scroll, lastFileVisible: true };
    },
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
        ({ selector, folders, first, last }) => {
          const scroller = document.querySelector(`${selector} .workspace-desktop__project-scroll`);
          if (!scroller) {
            return false;
          }
          const rows = Array.from(scroller.querySelectorAll("button.workspace-desktop__row"));
          const directories = rows.filter((row) => row.hasAttribute("aria-expanded"));
          const files = rows.filter((row) => !row.hasAttribute("aria-expanded"));
          const paths = new Set(files.map((row) => row.getAttribute("aria-label")));
          const viewport = scroller.getBoundingClientRect();
          return (
            directories.length === folders.length &&
            folders.every((path) =>
              directories.some(
                (row) =>
                  row.getAttribute("aria-label") === path &&
                  row.getAttribute("aria-expanded") === "true",
              ),
            ) &&
            folders.every(
              (path) => paths.has(`${path}/${first}`) && paths.has(`${path}/${last}`),
            ) &&
            files.every((row) => {
              const match = row
                .getAttribute("aria-label")
                ?.match(/^package-\d{2}\/module-(\d{3})\.ts$/);
              return (
                match &&
                folders.includes(row.getAttribute("aria-label")!.split("/")[0]!) &&
                Number(match[1]) <= 248 &&
                Number(match[1]) % 2 === 0 &&
                row.getAttribute("aria-description") === "Changed"
              );
            }) &&
            files.some((row) => {
              const bounds = row.getBoundingClientRect();
              return (
                bounds.height > 0 && bounds.top < viewport.bottom && bounds.bottom > viewport.top
              );
            })
          );
        },
        {
          selector: workspaceHost,
          folders: Array.from({ length: directoryCount }, (_, index) => directoryPath(index)),
          first: "module-000.ts",
          last: "module-248.ts",
        },
      );
      await settle(page);
      return {
        expectedChangedFiles: directoryCount * (filesPerDirectory / 2),
        retainedFolders: await page
          .locator(`${workspaceHost} .workspace-desktop__project-scroll [aria-expanded="true"]`)
          .count(),
        mountedChangedFiles: await page
          .locator(
            `${workspaceHost} .workspace-desktop__project-scroll [aria-description="Changed"]`,
          )
          .count(),
      };
    },
  },
  {
    id: "data-workspace-navigation-reveal",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected:
      "The final file supports native neighbor navigation and retains selection and scroll through search hide/reveal.",
    diagnostic:
      "Selection, keyboard and hidden-tree lifecycle proof; excluded from timing comparisons.",
    fixtureOverrides: createWorkspaceNavigationFixture,
    prepare: expandWorkspace,
    run: async (page, gateway) => {
      const path = `${directoryPath(19)}/module-249.ts`;
      const previous = `${directoryPath(19)}/module-248.ts`;
      const scroller = page.locator(`${workspaceHost} .workspace-desktop__project-scroll`);
      const last = scroller.getByRole("button", { name: path, exact: true });
      const focused = (expected: string) =>
        page.waitForFunction(
          (label) => document.activeElement?.getAttribute("aria-label") === label,
          expected,
        );
      await last.scrollIntoViewIfNeeded();
      await last.focus();
      await page.keyboard.press("Shift+Tab");
      await focused(previous);
      await page.keyboard.press("Tab");
      await focused(path);
      const request = { sessionKey, path: `${workspaceRoot}/${path}` };
      const after = (await gateway.getRequests("sessions.files.get", request)).length;
      await page.keyboard.press("Enter");
      await gateway.waitForRequest("sessions.files.get", { after, match: request });
      // Opening the first preview hides the tree; the reader toggle retains selection.
      await page.getByRole("button", { name: "Toggle file tree", exact: true }).click();
      await scroller.waitFor({ state: "visible" });
      await page.waitForFunction(
        ({ selector, path: filePath }) =>
          document
            .querySelector(`${selector} [aria-label="${filePath}"]`)
            ?.getAttribute("aria-current") === "true",
        { selector: `${workspaceHost} .workspace-desktop__project-scroll`, path },
      );
      await settle(page);
      const scrollBefore = await scroller.evaluate((element) => element.scrollTop);
      if (scrollBefore <= 0) {
        throw new Error("Last-file navigation did not move the workspace viewport");
      }
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: "Search files", exact: true })
        .click();
      await page
        .locator(`${workspaceHost} .workspace-desktop__catalog`)
        .waitFor({ state: "hidden" });
      await page
        .locator(workspaceHost)
        .getByRole("button", { name: "Close file search", exact: true })
        .click();
      await scroller.waitFor({ state: "visible" });
      await page.waitForFunction(
        ({ selector, path: filePath, top }) => {
          const element = document.querySelector(`${selector} .workspace-desktop__project-scroll`);
          const selected = element?.querySelector(`[aria-label="${filePath}"]`);
          return (
            element &&
            Math.abs(element.scrollTop - top) <= 1 &&
            selected?.getAttribute("aria-current") === "true"
          );
        },
        { selector: workspaceHost, path, top: scrollBefore },
      );
      await last.focus();
      await page.keyboard.press("Shift+Tab");
      await focused(previous);
      await page.keyboard.press("Tab");
      await focused(path);
      return {
        ...(await assertWorkspacePopulation(gateway)),
        scrollBefore,
        scrollAfter: await scroller.evaluate((element) => element.scrollTop),
        selectedFileRetained: true,
        nativeNeighborNavigation: true,
      };
    },
  },
];
