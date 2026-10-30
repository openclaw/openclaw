import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import type {
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
} from "../../ui/src/api/types.ts";
import { openChatSidePanelType } from "../../ui/src/e2e/chat-side-panel.test-support.ts";
import type { BoardSnapshot } from "../../ui/src/lib/board/types.ts";
import {
  controlUiSessionPath,
  type MockGatewayControls,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { navigation, openInteractionPanel } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionEvidence,
  InteractionFixtureOverrides,
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
const mobileWorkspaceHost = ".chat-workspace-mobile";
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

function boardSnapshot(revision = 1, widgetCount = tabCount * widgetsPerTab): BoardSnapshot {
  return {
    sessionKey,
    revision,
    tabs: Array.from({ length: tabCount }, (_, index) => ({
      tabId: `data-${index}`,
      title: `Data ${index + 1}`,
      position: index,
      chatDock: "right",
    })),
    widgets: Array.from({ length: widgetCount }, (_, index) => ({
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
      instanceId: `data-report-${index}`,
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
function createDataBoardFixture(
  widgetCount = tabCount * widgetsPerTab,
): InteractionFixtureOverrides {
  return {
    featureMethods: ["board.get"],
    featureEvents: ["board.changed"],
    controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
    methodResponses: { "board.get": boardSnapshot(1, widgetCount) },
  };
}

function galleryPreviewSnapshot(sample: BoardSnapshot, key: string): BoardSnapshot {
  return {
    ...sample,
    sessionKey: key,
    tabs: sample.tabs.slice(0, 1),
    widgets: sample.widgets.slice(0, 1),
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
          response: galleryPreviewSnapshot(sample, `agent:main:data-gallery-${index}`),
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

async function waitForBoard(page: Page, tab = 0, expectedWidgets = widgetsPerTab) {
  await page
    .locator(
      `${boardHost} [data-widget-name="data-widget-${tab * widgetsPerTab}"] openclaw-report-widget svg`,
    )
    .waitFor();
  await page.waitForFunction(
    ({ selector, count }) =>
      document.querySelectorAll(`${selector} openclaw-board-widget-cell:not([hidden])`).length ===
      count,
    { selector: boardHost, count: expectedWidgets },
  );
  await settle(page);
}

async function boardReportCounts(page: Page) {
  return page.locator(boardHost).evaluate((host) => ({
    mountedReports: host.querySelectorAll("openclaw-report-widget").length,
    widgetCells: host.querySelectorAll("openclaw-board-widget-cell").length,
    scrollHeight: host.scrollHeight,
  }));
}

async function prepareBoard(page: Page) {
  await openInteractionPanel(page);
  await waitForBoard(page);
}

function boardLiveUpdateScenario(
  id: string,
  widgetCount: number,
  prepareResponse = false,
  responseDelayMs = 0,
): InteractionScenario {
  let deferredRequestCount = 0;
  return {
    id,
    dataPage: "board",
    ...(responseDelayMs ? { explicitOnly: true } : {}),
    route: controlUiSessionPath(sessionKey),
    expected: `A board receipt updates one report from ${widgetCount} saved widgets.`,
    fixtureOverrides: () => createDataBoardFixture(widgetCount),
    rowSelector: ".board-report__point, .board-report__metrics dd",
    prepare: async (page, gateway) => {
      await openInteractionPanel(page);
      await waitForBoard(page, 0, Math.min(widgetCount, widgetsPerTab));
      if (prepareResponse) {
        await gateway.setMethodResponse("board.get", boardSnapshot(2, widgetCount));
      }
      if (responseDelayMs) {
        deferredRequestCount = await gateway.deferNext("board.get", { sessionKey });
      }
    },
    run: async (page, gateway) => {
      if (!prepareResponse) {
        await gateway.setMethodResponse("board.get", boardSnapshot(2, widgetCount));
      }
      await gateway.emitGatewayEvent("board.changed", {
        sessionKey,
        revision: 2,
        widget: "data-widget-0",
      });
      if (responseDelayMs) {
        await gateway.waitForRequest("board.get", {
          after: deferredRequestCount,
          match: { sessionKey },
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, responseDelayMs);
        });
        await gateway.resolveDeferred("board.get", undefined, { match: { sessionKey } });
      }
      await page.waitForFunction(
        (selector) =>
          document.querySelector(
            `${selector} [data-widget-name="data-widget-0"] .board-report__metrics dd`,
          )?.textContent === "2",
        boardHost,
      );
      await settle(page);
      return {
        totalWidgets: widgetCount,
        ...(responseDelayMs ? { addedRpcResponseDelayMs: responseDelayMs } : {}),
        ...(await boardReportCounts(page)),
      };
    },
  };
}

async function prepareGallery(page: Page) {
  await page.locator(`${galleryHost} [data-dashboard-session]`).first().waitFor();
  await page.waitForFunction(
    ({ selector, count }) => {
      const host = document.querySelector(selector);
      const represented = host?.querySelector(".dashboards-grid > [aria-setsize]");
      return (
        Number(represented?.getAttribute("aria-setsize")) === count ||
        host?.querySelectorAll("[data-dashboard-session]").length === count
      );
    },
    { selector: galleryHost, count: galleryCount },
  );
  await settle(page);
}

async function galleryPresentationCounts(page: Page) {
  return page.locator(galleryHost).evaluate((host) => {
    const cards = host.querySelectorAll("[data-dashboard-session]").length;
    const represented = host.querySelector(".dashboards-grid > [aria-setsize]");
    return {
      cards,
      links: host.querySelectorAll("[data-dashboard-session] a.dashboard-card__main").length,
      titles: host.querySelectorAll("[data-dashboard-session] h2").length,
      representedCards: represented ? Number(represented.getAttribute("aria-setsize")) : cards,
      windowed: represented !== null && cards < Number(represented.getAttribute("aria-setsize")),
    };
  });
}

async function initialGalleryPreviews(page: Page, gateway: MockGatewayControls) {
  await gateway.waitForRequest("board.get", {
    match: { sessionKey: "agent:main:data-gallery-0" },
  });
  await settle(page);
  const previewWindow = await page.locator(galleryHost).evaluate((host) => {
    const cards = Array.from(host.querySelectorAll("[data-dashboard-session]"));
    // Allow the preview's 200px margin and the grid's two overscan tracks.
    const margin = 200 + 2 * Math.max(...cards.map((card) => card.getBoundingClientRect().height));
    return cards
      .filter((card) => {
        const bounds = card.getBoundingClientRect();
        return bounds.bottom >= -margin && bounds.top <= innerHeight + margin;
      })
      .map((card) => card.getAttribute("data-dashboard-session"));
  });
  const requestedBoardIds = (await gateway.getRequests("board.get")).flatMap(({ params }) =>
    isRecord(params) &&
    typeof params.sessionKey === "string" &&
    params.sessionKey.startsWith("agent:main:data-gallery-")
      ? [params.sessionKey]
      : [],
  );
  if (
    requestedBoardIds.length > previewWindow.length ||
    requestedBoardIds.some((key) => !previewWindow.includes(key))
  ) {
    throw new Error("Initial gallery previews fetched outside the viewport and overscan window");
  }
  return { requestedBoardIds, initialPreviewWindow: previewWindow.length };
}

async function prepareWorkspace(page: Page) {
  await openChatSidePanelType(page, "Files");
  await page
    .locator((await mobileWorkspace(page)) ? mobileWorkspaceHost : workspaceHost)
    .getByRole("button", { name: directoryPath(0), exact: true })
    .waitFor();
  await settle(page);
}

async function settleWorkspace(page: Page) {
  await settle(page);
  await page
    .locator((await mobileWorkspace(page)) ? mobileWorkspaceHost : workspaceHost)
    .evaluate(async (element) => {
      await Promise.allSettled(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
  await settle(page);
}

async function mobileWorkspace(page: Page) {
  // The Files panel can still be mounting after its layout-menu action resolves.
  return page.locator(".chat-pane-cache__pane--active .agent-chat__header--mobile").isVisible();
}

async function openMobileWorkspaceFolder(page: Page, index: number) {
  const folder = directoryPath(index);
  const workspace = page.locator(mobileWorkspaceHost);
  await workspace.getByRole("button", { name: folder, exact: true }).click();
  await workspace.getByRole("button", { name: `${folder}/module-249.ts`, exact: true }).waitFor();
  await workspace.locator('.chat-workspace-mobile__scroll[aria-busy="false"]').waitFor();
  await settleWorkspace(page);
}

async function returnToMobileWorkspaceRoot(page: Page) {
  const workspace = page.locator(mobileWorkspaceHost);
  await workspace.locator(".chat-workspace-mobile__back").click();
  await workspace.getByRole("button", { name: directoryPath(0), exact: true }).waitFor();
  await settleWorkspace(page);
}

async function prepareWorkspaceLastFolder(page: Page, gateway: MockGatewayControls) {
  await expandWorkspace(page, gateway);
  if (await mobileWorkspace(page)) {
    await openMobileWorkspaceFolder(page, directoryCount - 1);
  }
}

async function expandWorkspace(page: Page, gateway: MockGatewayControls) {
  await prepareWorkspace(page);
  const mobile = await mobileWorkspace(page);
  for (let index = 0; index < directoryCount; index++) {
    if (mobile) {
      await openMobileWorkspaceFolder(page, index);
      await returnToMobileWorkspaceRoot(page);
      continue;
    }
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
    rowSelector: ".workspace-desktop__row, .chat-workspace-mobile__row",
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
    expected:
      "Searching 5,000 previously read files presents the 20 authoritative matching results on either Files surface.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row, .chat-workspace-mobile__row",
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
      const mobile = await mobileWorkspace(page);
      const host = mobile ? mobileWorkspaceHost : workspaceHost;
      if (!mobile) {
        await page.locator(host).getByRole("button", { name: "Search files", exact: true }).click();
      }
      await page.locator(host).getByRole("searchbox").fill("module-249");
      await gateway.waitForRequest("sessions.files.list", {
        match: { sessionKey, search: "module-249" },
      });
      await page.waitForFunction(
        ({ selector, expectedPaths, mobile: isMobile }) => {
          const paths = Array.from(
            document.querySelectorAll(
              isMobile
                ? `${selector} .chat-workspace-mobile__row`
                : `${selector} .workspace-desktop__results .workspace-desktop__row`,
            ),
            (row) => row.getAttribute("aria-label"),
          );
          return (
            paths.length === expectedPaths.length &&
            expectedPaths.every((path) => paths.includes(path))
          );
        },
        {
          selector: host,
          mobile,
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

function galleryRpcLatencyScenario(
  scenario: InteractionScenario,
  action: "first-render" | "scroll",
): InteractionScenario {
  const firstRender = action === "first-render";
  let measuring = false;
  let delayedGalleryLists = 0;
  let delayedPreviews = 0;
  return {
    ...scenario,
    id: `${scenario.id}-100ms`,
    explicitOnly: true,
    expected: `${scenario.expected} Measured Gallery RPC responses are delayed by 100ms.`,
    createRequestHandlers: (defaults) => {
      // The harness installs fresh handlers for each serial observation, before setup.
      measuring = false;
      delayedGalleryLists = 0;
      delayedPreviews = 0;
      const sample = boardSnapshot();
      return {
        ...(firstRender
          ? {
              "sessions.list": async (params: unknown) => {
                if (
                  measuring &&
                  isRecord(params) &&
                  params.source === "dashboard" &&
                  params.rowMode === "dashboard" &&
                  params.hasBoard === true &&
                  params.archived === "all"
                ) {
                  await new Promise<void>((resolve) => {
                    setTimeout(resolve, 100);
                  });
                  delayedGalleryLists += 1;
                }
                return defaults["sessions.list"]!(params);
              },
            }
          : {}),
        "board.get": async (params: unknown) => {
          if (
            !isRecord(params) ||
            typeof params.sessionKey !== "string" ||
            !/^agent:main:data-gallery-\d+$/.test(params.sessionKey)
          ) {
            throw new Error("Expected a Gallery preview request");
          }
          // Setup previews resolve normally; only reads issued during the action wait.
          if (measuring) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 100);
            });
            delayedPreviews += 1;
          }
          return galleryPreviewSnapshot(sample, params.sessionKey);
        },
      };
    },
    prepare: async (page, gateway) => {
      await scenario.prepare(page, gateway);
      // Pages has a separate active-only catalog under the same source.
      if (
        firstRender &&
        (
          await gateway.getRequests("sessions.list", {
            source: "dashboard",
            rowMode: "dashboard",
            hasBoard: true,
            archived: "all",
          })
        ).length > 0
      ) {
        throw new Error("Gallery list was fetched before the measured navigation");
      }
    },
    run: async (page, gateway) => {
      measuring = true;
      const evidence = await scenario.run(page, gateway);
      if ((firstRender && delayedGalleryLists === 0) || delayedPreviews === 0) {
        throw new Error("Expected measured Gallery RPC response delays");
      }
      return { ...evidence, delayedGalleryLists, delayedPreviews };
    },
  };
}

const galleryFirstRenderScenario: InteractionScenario = {
  id: "data-dashboards-first-render",
  dataPage: "dashboards",
  route: "/new",
  expected: "Opening Dashboards represents 1,000 cards with only nearby previews active.",
  fixtureOverrides: createGalleryFixture,
  rowSelector: "[data-dashboard-session]",
  prepare: async (page) => {
    await navigation(page, "pages");
  },
  run: async (page, gateway) => {
    await page.getByRole("link", { name: "Dashboards", exact: true }).click();
    await prepareGallery(page);
    const initialPreviews = await initialGalleryPreviews(page, gateway);
    // Request receipt alone would finish before the preview response is rendered.
    await page
      .locator('[data-dashboard-session="agent:main:data-gallery-0"] openclaw-report-widget svg')
      .waitFor();
    await settle(page);
    return {
      ...(await galleryPresentationCounts(page)),
      initialPreviewReads: initialPreviews.requestedBoardIds.length,
      initialPreviewWindow: initialPreviews.initialPreviewWindow,
    };
  },
};

const galleryScrollScenario: InteractionScenario = {
  id: "data-dashboards-scroll",
  dataPage: "dashboards",
  route: "/dashboards",
  expected: "Scrolling reveals the final gallery row and records its preview reads.",
  fixtureOverrides: createGalleryFixture,
  prepare: prepareGallery,
  run: async (page, gateway) => {
    const finalId = `data-gallery-${galleryCount - 1}`;
    const finalKey = `agent:main:${finalId}`;
    const initialPreviews = await initialGalleryPreviews(page, gateway);
    if (initialPreviews.requestedBoardIds.includes(finalKey)) {
      throw new Error("The offscreen final dashboard fetched its preview before scrolling");
    }
    const finalCard = page.locator(`[data-dashboard-session="${finalKey}"]`);
    const href = await finalCard.locator("a.dashboard-card__main").getAttribute("href");
    if (href !== `/dashboard/main/${finalId}`) {
      throw new Error(`Final dashboard has an incorrect native URL: ${href}`);
    }
    await finalCard.scrollIntoViewIfNeeded();
    await gateway.waitForRequest("board.get", {
      after: 0,
      match: { sessionKey: finalKey },
    });
    await settle(page);
    await finalCard.scrollIntoViewIfNeeded();
    await finalCard.locator(".dashboard-card__author").filter({ hasText: "By Author 9" }).waitFor();
    await finalCard.locator("openclaw-report-widget svg").waitFor();
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-dashboard-session="agent:main:data-gallery-999"]');
      const viewport = card?.closest(".content");
      if (!card || !viewport) {
        return false;
      }
      const bounds = card.getBoundingClientRect();
      const visible = viewport.getBoundingClientRect();
      return bounds.top < visible.bottom && bounds.bottom > visible.top;
    });
    const counts = await galleryPresentationCounts(page);
    if (counts.windowed && counts.cards > 100) {
      throw new Error("Scrolling mounted an unbounded gallery window");
    }
    return {
      ...counts,
      initialPreviewReads: initialPreviews.requestedBoardIds.length,
      initialPreviewWindow: initialPreviews.initialPreviewWindow,
      previewReads: (await gateway.getRequests("board.get")).length,
    };
  },
};

export const dataBoardScenarios: readonly InteractionScenario[] = [
  galleryFirstRenderScenario,
  galleryRpcLatencyScenario(galleryFirstRenderScenario, "first-render"),
  {
    id: "data-board-first-render",
    dataPage: "board",
    route: controlUiSessionPath(sessionKey),
    expected: "Opening Dashboard renders 250 saved core reports from a 1,000-widget board.",
    fixtureOverrides: () => createDataBoardFixture(),
    rowSelector: "openclaw-board-widget-cell",
    prepare: async (page) => {
      await page.locator(".chat-thread").first().waitFor();
    },
    run: async (page) => {
      await prepareBoard(page);
      return {
        visibleWidgets: widgetsPerTab,
        totalWidgets: tabCount * widgetsPerTab,
        ...(await boardReportCounts(page)),
      };
    },
  },
  {
    id: "data-board-tab-switch",
    dataPage: "board",
    route: controlUiSessionPath(sessionKey),
    expected: "Switching tabs retains the previous 250 widget instances and presents the next 250.",
    fixtureOverrides: () => createDataBoardFixture(),
    rowSelector: "openclaw-board-widget-cell",
    prepare: prepareBoard,
    run: async (page) => {
      await page.locator(`${boardHost} [data-board-tab-id="data-1"]`).click();
      await waitForBoard(page, 1);
      return { visitedWidgets: widgetsPerTab * 2, ...(await boardReportCounts(page)) };
    },
  },
  {
    id: "data-board-tab-return",
    dataPage: "board",
    route: controlUiSessionPath(sessionKey),
    expected: "Returning to a visited tab preserves its already rendered report bodies.",
    fixtureOverrides: () => createDataBoardFixture(),
    rowSelector: "openclaw-report-widget",
    prepare: async (page) => {
      await prepareBoard(page);
      await page.locator(`${boardHost} [data-board-tab-id="data-1"]`).click();
      await waitForBoard(page, 1);
      await page.locator(`${boardHost} [data-board-tab-id="data-0"]`).click();
      await waitForBoard(page);
    },
    run: async (page) => {
      await page.locator(`${boardHost} [data-board-tab-id="data-1"]`).click();
      await waitForBoard(page, 1);
      return boardReportCounts(page);
    },
  },
  boardLiveUpdateScenario("data-board-live-update", tabCount * widgetsPerTab),
  {
    ...boardLiveUpdateScenario("data-board-live-update-staged", tabCount * widgetsPerTab, true),
    explicitOnly: true,
  },
  // Current new-write cap; the existing 1,000-widget case is an over-cap stress fixture.
  boardLiveUpdateScenario("data-board-live-update-production", 48, true),
  boardLiveUpdateScenario(
    "data-board-live-update-rpc-delay-100ms",
    tabCount * widgetsPerTab,
    false,
    100,
  ),
  boardLiveUpdateScenario(
    "data-board-live-update-staged-rpc-delay-100ms",
    tabCount * widgetsPerTab,
    true,
    100,
  ),
  boardLiveUpdateScenario("data-board-live-update-production-rpc-delay-100ms", 48, true, 100),
  {
    id: "data-board-scroll",
    dataPage: "board",
    route: controlUiSessionPath(sessionKey),
    expected: "Scrolling the 250-widget board preserves its mounted reports.",
    fixtureOverrides: () => createDataBoardFixture(),
    prepare: prepareBoard,
    run: async (page) => {
      const scroll = await scrollSurface(page, boardHost);
      await page
        .locator(`${boardHost} [data-widget-name="data-widget-249"] openclaw-report-widget svg`)
        .waitFor();
      return { ...scroll, ...(await boardReportCounts(page)) };
    },
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
    expected: "Sorting all 1,000 dashboards preserves their represented count and title order.",
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
      const counts = await galleryPresentationCounts(page);
      if (counts.representedCards !== galleryCount || (counts.windowed && counts.cards > 100)) {
        throw new Error("Sorting lost dashboard results or mounted an unbounded gallery window");
      }
      return counts;
    },
  },
  galleryScrollScenario,
  galleryRpcLatencyScenario(galleryScrollScenario, "scroll"),
  {
    id: "data-dashboards-responsive-navigation",
    dataPage: "dashboards",
    diagnostic: "Multi-viewport correctness and capture; not a timing comparison.",
    route: "/dashboards",
    expected:
      "All 1,000 results remain represented, mounted links stay native, the final card retains focus after scrolling, and 3/2/1-column layouts fit the viewport.",
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
      let maxMountedCards = 0;
      let windowedAtAllWidths = true;
      try {
        await finalLink.focus();
        await settle(page);
        for (const [width, columns] of [
          [1280, 3],
          [900, 2],
          [520, 1],
        ] as const) {
          await page.setViewportSize({ width, height: viewport.height });
          await settle(page);
          if (
            !(await finalLink.evaluate(
              (link, original) => link === original && document.activeElement === original,
              originalLink,
            ))
          ) {
            throw new Error(`Resizing lost the focused final dashboard at ${width}px`);
          }
          await page
            .locator('[data-dashboard-session="agent:main:data-gallery-0"] a.dashboard-card__main')
            .focus();
          for (let index = 1; index <= 15; index += 1) {
            await page.keyboard.press("Tab");
            const focusedKey = await page.evaluate(() =>
              document.activeElement
                ?.closest("[data-dashboard-session]")
                ?.getAttribute("data-dashboard-session"),
            );
            if (focusedKey !== `agent:main:data-gallery-${index}`) {
              throw new Error(`Native Tab skipped dashboard ${index} at ${width}px`);
            }
          }
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
          const counts = await galleryPresentationCounts(page);
          maxMountedCards = Math.max(maxMountedCards, counts.cards);
          windowedAtAllWidths &&= counts.windowed;
          if (
            counts.representedCards !== galleryCount ||
            counts.cards !== counts.links ||
            counts.cards !== counts.titles ||
            (counts.windowed && counts.cards > 100)
          ) {
            throw new Error(
              `Gallery lost results, native titles/links, or bounded rendering at ${width}px`,
            );
          }
        }
        return {
          cards: galleryCount,
          responsiveLayouts: 3,
          retainedFinalLink: true,
          focusRetainedThroughResize: true,
          maxMountedCards,
          windowedAtAllWidths,
        };
      } finally {
        await page.setViewportSize(viewport);
        await originalLink.dispose();
      }
    },
  },
  {
    id: "data-dashboards-native-navigation",
    dataPage: "dashboards",
    diagnostic: "Native link activation and destination rendering; not a timing comparison.",
    route: "/dashboards",
    expected: "Enter on the final native dashboard link opens its route and saved report.",
    fixtureOverrides: createGalleryFixture,
    prepare: prepareGallery,
    run: async (page) => {
      const link = page.locator(
        '[data-dashboard-session="agent:main:data-gallery-999"] a.dashboard-card__main',
      );
      await link.scrollIntoViewIfNeeded();
      await link.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname === "/dashboard/main/data-gallery-999");
      await page.locator(galleryHost).waitFor({ state: "hidden" });
      const report = page.locator(
        '.board-session-surface:visible [data-widget-name="data-widget-0"] openclaw-report-widget',
      );
      await report.locator("svg").waitFor({ state: "visible" });
      await report.getByText("Throughput 0", { exact: true }).waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const widget = document.querySelector(
          '.board-session-surface:not([hidden]) [data-widget-name="data-widget-0"] openclaw-report-widget',
        );
        const values = widget?.querySelectorAll(".board-report__values dd");
        return (
          values?.length === 12 &&
          values[0]?.textContent === "10" &&
          values[11]?.textContent === "87"
        );
      });
      return { activatedFinalLink: true, renderedDestinationReport: true };
    },
  },
  workspaceInitialScenario(0),
  workspaceInitialScenario(100),
  {
    id: "data-workspace-expand",
    dataPage: "workspace",
    route: controlUiSessionPath(sessionKey),
    expected:
      "Expanding the last desktop folder or entering the last mobile folder presents all 250 children after 5,000 files were read.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row, .chat-workspace-mobile__row",
    prepare: async (page, gateway) => {
      await expandWorkspace(page, gateway);
      if (await mobileWorkspace(page)) {
        return;
      }
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
      if (await mobileWorkspace(page)) {
        await openMobileWorkspaceFolder(page, 19);
        const count = await page
          .locator(`${mobileWorkspaceHost} .chat-workspace-mobile__row`)
          .count();
        if (count !== filesPerDirectory) {
          throw new Error(`Expected 250 mobile folder files, got ${count}`);
        }
        return;
      }
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
    expected:
      "Files scrolls to the final child: desktop across 5,000 mounted files, mobile within the last 250-file folder.",
    fixtureOverrides: createWorkspaceFixture,
    prepare: prepareWorkspaceLastFolder,
    run: async (page) => {
      if (await mobileWorkspace(page)) {
        const scroller = `${mobileWorkspaceHost} .chat-workspace-mobile__scroll`;
        const scroll = await scrollSurface(page, scroller);
        await page.waitForFunction(
          ({ selector, path }) => {
            const port = document.querySelector(selector);
            const row = port?.querySelector(`[aria-label="${path}"]`);
            if (!port || !row) {
              return false;
            }
            const frame = port.getBoundingClientRect(),
              bounds = row.getBoundingClientRect();
            return bounds.height > 0 && bounds.top < frame.bottom && bounds.bottom > frame.top;
          },
          { selector: scroller, path: `${directoryPath(19)}/module-249.ts` },
        );
        return { ...scroll, lastFileVisible: true, mobileFolderFiles: filesPerDirectory };
      }
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
    expected:
      "Changed retains desktop modified files and folders; mobile retains exactly the 60 touched modified files.",
    fixtureOverrides: createWorkspaceFixture,
    rowSelector: ".workspace-desktop__row, .chat-workspace-mobile__row",
    prepare: expandWorkspace,
    run: async (page): Promise<InteractionEvidence> => {
      if (await mobileWorkspace(page)) {
        const workspace = page.locator(mobileWorkspaceHost);
        await workspace
          .locator(".chat-workspace-mobile__filters")
          .getByRole("button", { name: "Changed", exact: true })
          .click();
        await page.waitForFunction(
          ({ selector, expected }) => {
            const rows = Array.from(
              document.querySelectorAll(`${selector} .chat-workspace-mobile__row`),
            );
            const paths = rows.map((row) => row.getAttribute("aria-label"));
            return (
              paths.length === expected.length && expected.every((path) => paths.includes(path))
            );
          },
          {
            selector: mobileWorkspaceHost,
            expected: Array.from({ length: directoryCount }, (_, index) =>
              [0, 2, 4].map(
                (file) => `${directoryPath(index)}/module-${String(file).padStart(3, "0")}.ts`,
              ),
            ).flat(),
          },
        );
        return {
          expectedChangedFiles: directoryCount * 3,
          mountedChangedFiles: directoryCount * 3,
          mobileTouchedFiles: true,
        };
      }
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
    prepare: prepareWorkspaceLastFolder,
    run: async (page, gateway) => {
      const path = `${directoryPath(19)}/module-249.ts`;
      if (await mobileWorkspace(page)) {
        const workspace = page.locator(mobileWorkspaceHost);
        const scroller = workspace.locator(".chat-workspace-mobile__scroll");
        const last = workspace.getByRole("button", { name: path, exact: true });
        await last.scrollIntoViewIfNeeded();
        await last.focus();
        await page.keyboard.press("Shift+Tab");
        await page.waitForFunction(
          (expected) => document.activeElement?.getAttribute("aria-label") === expected,
          `${directoryPath(19)}/module-248.ts`,
        );
        await page.keyboard.press("Tab");
        await page.waitForFunction(
          (expected) => document.activeElement?.getAttribute("aria-label") === expected,
          path,
        );
        const request = { sessionKey, path: `${workspaceRoot}/${path}` };
        const after = (await gateway.getRequests("sessions.files.get", request)).length;
        const scrollBefore = await scroller.evaluate((element) => element.scrollTop);
        await page.keyboard.press("Enter");
        await gateway.waitForRequest("sessions.files.get", { after, match: request });
        await page
          .getByText("// Synthetic workspace navigation proof.", { exact: false })
          .waitFor();
        await page
          .locator(".sidebar-file-mobile__rail:visible")
          .getByRole("button", { name: "Files", exact: true })
          .first()
          .click();
        await last.waitFor();
        await page.waitForFunction(
          ({ selector, top }) =>
            Math.abs((document.querySelector(selector)?.scrollTop ?? -1) - top) <= 1,
          { selector: `${mobileWorkspaceHost} .chat-workspace-mobile__scroll`, top: scrollBefore },
        );
        return {
          ...(await assertWorkspacePopulation(gateway)),
          scrollBefore,
          scrollAfter: await scroller.evaluate((element) => element.scrollTop),
          nativeNeighborNavigation: true,
          readerReturnedToFolder: true,
          mobileFolder: true,
        };
      }
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
