import { Buffer } from "node:buffer";
import type { Page } from "playwright";
import type {
  NativeBrowserMessage,
  NativeBrowserState,
} from "../../ui/src/app/native-browser-bridge.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../ui/src/components/panel-toggle-contract.ts";
import type {
  InteractionEvidence,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";
import type { ControlUiResourceCounts } from "./control-ui-resource-counts.ts";

const sessionKeys = ["agent:main:interaction-a", "agent:main:interaction-b"] as const;
const activePane = ".chat-pane-cache__pane--active";
const cardSelector = "openclaw-browser-dashboard-widget";
const cardCount = 100;
const screenshot =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
const mediaPrefix = "/synthetic/browser-resources/";

function cardIdentity(index: number) {
  return { name: `browser-resource-${index}`, instanceId: `browser-resource-${index}` };
}

function browserBoardSnapshot(count = cardCount, revision = 1) {
  return {
    sessionKey: sessionKeys[0],
    revision,
    tabs: ["main", "second"].map((tabId, position) => ({
      tabId,
      title: `Browser ${tabId}`,
      position,
      chatDock: "right",
    })),
    widgets: Array.from({ length: count }, (_, index) => ({
      ...cardIdentity(index),
      tabId: index < cardCount / 2 ? "main" : "second",
      title: `Browser resource ${index}`,
      contentKind: "plugin",
      pluginKind: "browser:dashboard",
      props: { url: `https://browser-resource.example/${index}` },
      sizeW: 4,
      sizeH: 3,
      position: index,
      grantState: "none",
      revision: 1,
    })),
  };
}

/** Synthetic protocol replies; every card still uses the production widget and BrowserPanel. */
export function browserResourceMethodResponses() {
  return {
    "board.get": browserBoardSnapshot(),
    "browser.dashboard.request": {
      cases: Array.from({ length: cardCount }, (_, index) => {
        const dashboard = cardIdentity(index);
        const url = `https://browser-resource.example/${index}`;
        const targetId = `browser-resource-tab-${index}`;
        return [
          {
            match: { path: "/dashboard", dashboard },
            response: {
              ...dashboard,
              sessionKey: sessionKeys[0],
              revision: 1,
              paused: false,
              stopping: false,
              url,
              browserTab: { target: "host", profile: "openclaw", targetId },
            },
          },
          {
            match: { path: "/tabs", dashboard },
            response: {
              running: true,
              tabs: [{ tabId: targetId, targetId, title: `Resource ${index}`, url }],
            },
          },
          {
            match: { path: "/screencast", dashboard },
            response: {
              __mockError: {
                code: "UNAVAILABLE",
                message: "Synthetic screenshot-only browser",
                details: { code: "SCREENCAST_UNSUPPORTED" },
              },
            },
          },
          {
            match: { path: "/screenshot", dashboard },
            response: { path: `${mediaPrefix}${index}.png`, url },
          },
          {
            match: { path: "/act", dashboard },
            response: {
              result: { cssWidth: 640, cssHeight: 360, title: `Resource ${index}`, url },
            },
          },
        ];
      }).flat(),
    },
  };
}

type Presentation = Extract<NativeBrowserMessage, { type: "present" }>;
type NativeFixtureSnapshot = {
  state: NativeBrowserState;
  presentations: Presentation[];
  presentCalls: number;
  releaseCalls: number;
  navigateCalls: number;
  unsupportedCalls: number;
};
type NativeFixtureControls = {
  snapshot(): NativeFixtureSnapshot;
  publish(): void;
};

/** A transport fixture only: native painting, responder focus and process CPU are not emulated. */
async function installSyntheticNativeBrowser(page: Page) {
  await page.addInitScript((keys: readonly [string, string]) => {
    if (window !== window.top) {
      return;
    }
    let state: NativeBrowserState = {
      revision: 1,
      tabs: Array.from({ length: 20 }, (_, index) => ({
        id: `native-resource-${index}`,
        sessionKey: keys[index < 10 ? 0 : 1],
        url: `https://native-resource.example/${index}`,
        title: `Native resource ${index}`,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        openedBy: "web",
      })),
    };
    const presentations = new Map<string, Presentation>();
    let presentCalls = 0;
    let releaseCalls = 0;
    let navigateCalls = 0;
    let unsupportedCalls = 0;
    function publish() {
      state = { ...state, revision: state.revision + 1 };
      Reflect.set(window, "__OPENCLAW_NATIVE_BROWSER__", state);
      window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", { detail: state }));
    }
    Reflect.set(window, "__OPENCLAW_NATIVE_BROWSER__", state);
    Reflect.set(window, "__openclawSyntheticNativeBrowser", {
      snapshot: () =>
        structuredClone({
          state,
          presentations: [...presentations.values()],
          presentCalls,
          releaseCalls,
          navigateCalls,
          unsupportedCalls,
        }),
      publish,
    } satisfies NativeFixtureControls);
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          openclawBrowser: {
            async postMessage(message: NativeBrowserMessage) {
              if (message.type === "present") {
                presentCalls++;
                presentations.set(message.scope, structuredClone(message));
                return { ok: true };
              }
              if (message.type === "release-scope") {
                releaseCalls++;
                presentations.delete(message.scope);
                return { ok: true };
              }
              if (message.type === "navigate") {
                const tab = state.tabs.find((candidate) => candidate.id === message.tabId);
                if (tab) {
                  navigateCalls++;
                  state = {
                    ...state,
                    tabs: state.tabs.map((candidate) =>
                      candidate === tab ? Object.assign({}, tab, { url: message.url }) : candidate,
                    ),
                  };
                  publish();
                  return { ok: true };
                }
              }
              unsupportedCalls++;
              return {
                ok: false,
                error: `Synthetic native transport does not implement ${message.type}`,
              };
            },
          },
        },
      },
    });
  }, sessionKeys);
}

async function setupBrowserResources(page: Page) {
  await installSyntheticNativeBrowser(page);
  await page.route("**/__openclaw__/assistant-media?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("source");
    if (path?.startsWith(mediaPrefix) && /^\d+\.png$/.test(path.slice(mediaPrefix.length))) {
      await route.fulfill({ contentType: "image/png", body: Buffer.from(screenshot, "base64") });
    } else {
      await route.continue();
    }
  });
}

async function browserSnapshot(page: Page): Promise<InteractionEvidence> {
  return page.evaluate(
    ({ cardSelector: selector, cardCount: expectedCardCount, toggleEvent }) => {
      // SAFETY: setup installs this transport before the app mounts; resource instrumentation is optional.
      const fixture = Reflect.get(
        window,
        "__openclawSyntheticNativeBrowser",
      ) as NativeFixtureControls;
      const resourceReader = Reflect.get(window, "openclawResourceCounts") as
        | (() => ControlUiResourceCounts)
        | undefined;
      const resource = resourceReader?.();
      const native = fixture.snapshot();
      const cards = [...document.querySelectorAll(selector)];
      const panels = [...document.querySelectorAll("openclaw-browser-panel")];
      const activeCards = cards.filter((card) => {
        const cell = card.closest("openclaw-board-widget-cell");
        return cell && !cell.hasAttribute("hidden") && !cell.hasAttribute("inert");
      });
      const mismatchedTargets = cards.filter((card) => {
        const name = card.closest("[data-widget-name]")?.getAttribute("data-widget-name");
        const index = Number(name?.replace("browser-resource-", ""));
        const panel = card.querySelector("openclaw-browser-panel");
        return (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= expectedCardCount ||
          !panel ||
          Reflect.get(panel, "fixedTab")?.targetId !== `browser-resource-tab-${index}`
        );
      }).length;
      const result: InteractionEvidence = {
        fixtureCards: expectedCardCount,
        fixtureNativeTabs: native.state.tabs.length,
        mountedCards: cards.length,
        activeCards: activeCards.length,
        mountedBrowserPanels: panels.length,
        mountedNativeStages: document.querySelectorAll(".bp-stage--native").length,
        readySnapshots: cards.filter((card) => {
          const image = card.querySelector<HTMLImageElement>(".bp-shot");
          return image?.complete && image.naturalWidth > 0;
        }).length,
        mismatchedTargets,
        nativeScopes: native.presentations.length,
        visibleNativeScopes: native.presentations.filter((presentation) => presentation.visible)
          .length,
        nativePresentCalls: native.presentCalls,
        nativeReleaseCalls: native.releaseCalls,
        nativeNavigateCalls: native.navigateCalls,
        nativeUnsupportedCalls: native.unsupportedCalls,
        documentVisible: document.visibilityState === "visible",
        instrumented: Boolean(resource),
      };
      if (resource) {
        Object.assign(result, {
          nativeStateListeners:
            resource.listenerTypes.window["openclaw:native-browser-state:bubble"] ?? 0,
          nativeStateCallbacks:
            resource.listenerCallbackTypes.window["openclaw:native-browser-state:bubble"] ?? 0,
          dockToggleListeners: resource.listenerTypes.window[`${toggleEvent}:bubble`] ?? 0,
          captureScrollListeners: resource.listenerTypes.document["scroll:capture"] ?? 0,
          captureScrollCallbacks: resource.listenerCallbackTypes.document["scroll:capture"] ?? 0,
          windowResizeListeners: resource.listenerTypes.window["resize:bubble"] ?? 0,
          windowResizeCallbacks: resource.listenerCallbackTypes.window["resize:bubble"] ?? 0,
          resizeObservers: resource.observers.ResizeObserver.active,
          resizeTargets: resource.observers.ResizeObserver.targets,
          resizeCallbacks: resource.observers.ResizeObserver.callbacks,
          intersectionObservers: resource.observers.IntersectionObserver.active,
          intersectionTargets: resource.observers.IntersectionObserver.targets,
          intersectionCallbacks: resource.observers.IntersectionObserver.callbacks,
          intervals: resource.intervals.active,
          intervalCallbacks: resource.intervals.callbacks,
          timeouts: resource.timeouts.active,
          timeoutCallbacks: resource.timeouts.callbacks,
          animationFrames: resource.animationFrames.active,
          animationFrameCallbacks: resource.animationFrames.callbacks,
          idleCallbacks: resource.idleCallbacks.callbacks,
          schedulingCallbacksComplete: resource.schedulingCoverage.callbacksComplete,
          schedulingActiveComplete: resource.schedulingCoverage.activeComplete,
          schedulingCancellationsComplete: resource.schedulingCoverage.cancellationsComplete,
        });
      }
      return result;
    },
    { cardSelector, cardCount, toggleEvent: BROWSER_PANEL_TOGGLE_EVENT },
  );
}

function phaseEvidence(phase: string, snapshot: InteractionEvidence): InteractionEvidence {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [`${phase}.${key}`, value]),
  );
}

async function assertCards(page: Page, count: number) {
  await page.waitForFunction(
    ({ selector, count: expectedCount }) => {
      const cards = [...document.querySelectorAll(selector)];
      return (
        cards.length === expectedCount &&
        cards.every((card) => {
          const image = card.querySelector<HTMLImageElement>(".bp-shot");
          return image?.complete && image.naturalWidth > 0;
        })
      );
    },
    { selector: cardSelector, count },
  );
  const snapshot = await browserSnapshot(page);
  if (snapshot.mismatchedTargets !== 0 || snapshot.mountedNativeStages !== 0) {
    throw new Error(
      "Dashboard cards must retain their distinct remote targets without native stages",
    );
  }
}

async function selectBoardTab(page: Page, tabId: "main" | "second") {
  await page.locator(`${activePane} .board-tabs [data-board-tab-id="${tabId}"]`).click();
  await page
    .locator(`${activePane} .board-tabs [data-board-tab-id="${tabId}"][aria-selected="true"]`)
    .waitFor();
}

type BrowserResourceDependencies = {
  route: string;
  openPanel(page: Page, panel: "Dashboard" | "Browser", sessionIndex?: 0 | 1): Promise<void>;
  switchSession(page: Page, index: 0 | 1): Promise<void>;
  prepare(page: Page): Promise<void>;
  settle(page: Page): Promise<void>;
};

export function createBrowserResourceScenarios(
  deps: BrowserResourceDependencies,
): InteractionScenario[] {
  async function prepareCards(page: Page) {
    await deps.openPanel(page, "Dashboard");
    await assertCards(page, cardCount / 2);
    await selectBoardTab(page, "second");
    await assertCards(page, cardCount);
    await selectBoardTab(page, "main");
    await deps.prepare(page);
    const snapshot = await browserSnapshot(page);
    if (snapshot.activeCards !== cardCount / 2 || snapshot.mismatchedTargets !== 0) {
      throw new Error("Expected fifty active and fifty retained real browser cards");
    }
  }
  async function prepareNative(page: Page) {
    await deps.openPanel(page, "Browser");
    await page.locator(`${activePane} .bp-stage--native`).waitFor();
    await deps.switchSession(page, 1);
    await deps.openPanel(page, "Browser", 1);
    await page.locator(`${activePane} .bp-stage--native`).waitFor();
    await deps.switchSession(page, 0);
    await page.locator(`${activePane} .bp-stage--native`).waitFor();
    await deps.prepare(page);
    await assertNativeGeometry(page);
  }
  async function idle(page: Page, visibility: "visible" | "hidden") {
    const before = await browserSnapshot(page);
    if (before.documentVisible !== (visibility === "visible")) {
      throw new Error(`Expected native ${visibility} document before idle`);
    }
    // Driver-side native wait avoids adding a measured page timer or simulating visibility.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 3_000);
    });
    const after = await browserSnapshot(page);
    if (
      before.documentVisible !== after.documentVisible ||
      before.mountedBrowserPanels !== after.mountedBrowserPanels
    ) {
      throw new Error("Document visibility or mounted browser panels changed during idle");
    }
    return {
      syntheticNativeTransport: true,
      idleSeconds: 3,
      ...phaseEvidence("before", before),
      ...phaseEvidence("after", after),
    };
  }
  return [
    {
      id: "browser-card-resources",
      route: deps.route,
      fixture: { browserResources: true },
      resourceOnly: true,
      observationBrowser: true,
      setup: setupBrowserResources,
      prepare: prepareCards,
      expected:
        "100 production browser cards retain distinct targets across dashboard events, tab activation, retirement and remount; Gateway operational listeners remain direct.",
      run: async (page, gateway) => {
        const evidence = phaseEvidence("mounted", await browserSnapshot(page));
        const active = { path: "/dashboard", dashboard: cardIdentity(0), method: "GET" };
        const unrelated = { path: "/dashboard", dashboard: cardIdentity(1), method: "GET" };
        const hidden = { path: "/dashboard", dashboard: cardIdentity(50), method: "GET" };
        const activeBefore = (await gateway.getRequests("browser.dashboard.request", active))
          .length;
        const unrelatedBefore = (await gateway.getRequests("browser.dashboard.request", unrelated))
          .length;
        const hiddenBefore = (await gateway.getRequests("browser.dashboard.request", hidden))
          .length;
        await gateway.emitGatewayEvent("plugin.browser.dashboard_changed", cardIdentity(0));
        await gateway.waitForRequest("browser.dashboard.request", {
          after: activeBefore,
          match: active,
        });
        await gateway.emitGatewayEvent("plugin.browser.dashboard_changed", cardIdentity(50));
        await deps.settle(page);
        if (
          (await gateway.getRequests("browser.dashboard.request", active)).length !==
            activeBefore + 1 ||
          (await gateway.getRequests("browser.dashboard.request", unrelated)).length !==
            unrelatedBefore ||
          (await gateway.getRequests("browser.dashboard.request", hidden)).length !== hiddenBefore
        ) {
          throw new Error(
            "Dashboard event escaped its active target or dispatched a hidden target",
          );
        }
        await selectBoardTab(page, "second");
        await gateway.waitForRequest("browser.dashboard.request", {
          after: hiddenBefore,
          match: hidden,
        });
        await selectBoardTab(page, "main");
        await page.evaluate(() => {
          const fixture = Reflect.get(
            window,
            "__openclawSyntheticNativeBrowser",
          ) as NativeFixtureControls;
          fixture.publish();
        });
        await deps.settle(page);
        Object.assign(evidence, phaseEvidence("afterEvents", await browserSnapshot(page)));
        for (const [count, revision, phase] of [
          [50, 2, "half"],
          [0, 3, "retired"],
          [100, 4, "remounted"],
        ] as const) {
          await gateway.setMethodResponse("board.get", browserBoardSnapshot(count, revision));
          await gateway.emitGatewayEvent("board.changed", { sessionKey: sessionKeys[0], revision });
          if (count === cardCount) {
            // Retiring every cell also retires its first-activation state.
            await assertCards(page, cardCount / 2);
            await selectBoardTab(page, "second");
            await assertCards(page, cardCount);
            await selectBoardTab(page, "main");
          } else {
            await assertCards(page, count);
          }
          await deps.settle(page);
          Object.assign(evidence, phaseEvidence(phase, await browserSnapshot(page)));
        }
        return {
          ...evidence,
          syntheticNativeTransport: true,
          activeTargetRefresh: true,
          unrelatedTargetUnchanged: true,
          hiddenTargetDeferred: true,
        };
      },
    },
    {
      id: "browser-native-stage-resources",
      route: deps.route,
      resourceOnly: true,
      observationBrowser: true,
      setup: installSyntheticNativeBrowser,
      prepare: prepareNative,
      expected:
        "Real native Browser panes retain their scopes across sessions and post viewport geometry; synthetic transport proves web lifecycle only.",
      run: async (page) => {
        const before = await browserSnapshot(page);
        const viewport = page.viewportSize();
        if (!viewport) {
          throw new Error("Native geometry scenario needs a bounded viewport");
        }
        await page.setViewportSize({ ...viewport, height: viewport.height + 80 });
        await deps.settle(page);
        await assertNativeGeometry(page);
        const resized = await browserSnapshot(page);
        await page
          .locator(`${activePane} .bp-url`)
          .fill("https://native-resource.example/navigated");
        await page.locator(`${activePane} .bp-url`).press("Enter");
        await page.waitForFunction(() => {
          const fixture = Reflect.get(
            window,
            "__openclawSyntheticNativeBrowser",
          ) as NativeFixtureControls;
          const state = fixture.snapshot().state;
          return (
            state.tabs.filter((tab) => tab.url === "https://native-resource.example/navigated")
              .length === 1 &&
            state.tabs.every(
              (tab) =>
                tab.sessionKey !== "agent:main:interaction-b" ||
                tab.url !== "https://native-resource.example/navigated",
            )
          );
        });
        const scope = await page
          .locator(`${activePane} openclaw-browser-panel[data-native-browser-scope]`)
          .getAttribute("data-native-browser-scope");
        await deps.switchSession(page, 1);
        await assertNativeGeometry(page);
        await deps.switchSession(page, 0);
        await assertNativeGeometry(page);
        const retainedScope = await page
          .locator(`${activePane} openclaw-browser-panel[data-native-browser-scope]`)
          .getAttribute("data-native-browser-scope");
        if (!scope || scope !== retainedScope) {
          throw new Error("Session return replaced the retained native presentation scope");
        }
        await page.evaluate(() => {
          const fixture = Reflect.get(
            window,
            "__openclawSyntheticNativeBrowser",
          ) as NativeFixtureControls;
          fixture.publish();
        });
        await page.setViewportSize(viewport);
        await deps.settle(page);
        await assertNativeGeometry(page);
        const after = await browserSnapshot(page);
        if (
          after.mountedBrowserPanels !== before.mountedBrowserPanels ||
          Number(after.mountedBrowserPanels) < 2 ||
          Number(after.mountedNativeStages) < 1
        ) {
          throw new Error("Expected both real session Browser panels to remain mounted");
        }
        if (after.nativeUnsupportedCalls !== 0 || after.nativeNavigateCalls !== 1) {
          throw new Error("Unexpected synthetic native operation or navigation count");
        }
        return {
          syntheticNativeTransport: true,
          retainedScope: true,
          nativeGeometryMatches: true,
          nativePaintingProven: false,
          ancestorScrollMovementProven: false,
          ...phaseEvidence("before", before),
          ...phaseEvidence("resized", resized),
          ...phaseEvidence("after", after),
        };
      },
    },
    ...(["cards", "native-stage"] as const).flatMap((kind) =>
      (["visible", "hidden"] as const).map((visibility): InteractionScenario => ({
        id: `browser-${kind}-idle-${visibility}`,
        route: deps.route,
        fixture: kind === "cards" ? { browserResources: true } : undefined,
        resourceOnly: true,
        observationBrowser: true,
        visibility: visibility === "hidden" ? visibility : undefined,
        setup: kind === "cards" ? setupBrowserResources : installSyntheticNativeBrowser,
        prepare: kind === "cards" ? prepareCards : prepareNative,
        expected: `Production browser ${kind} stay mounted during three genuinely ${visibility} idle seconds; callbacks are descriptive, not OS-wakeup or native-process CPU evidence.`,
        run: (page) => idle(page, visibility),
      })),
    ),
  ];
}

async function assertNativeGeometry(page: Page) {
  await page.waitForFunction((paneSelector) => {
    const fixture = Reflect.get(
      window,
      "__openclawSyntheticNativeBrowser",
    ) as NativeFixtureControls;
    const active = document.querySelector(
      `${paneSelector} openclaw-browser-panel[data-native-browser-scope]`,
    );
    const stage = active?.querySelector(".bp-stage--native");
    if (!active || !stage) {
      return false;
    }
    const state = fixture.snapshot();
    const presentation = state.presentations.find(
      (candidate) => candidate.scope === active.getAttribute("data-native-browser-scope"),
    );
    const bounds = stage.getBoundingClientRect();
    const rect = presentation?.rect;
    return Boolean(
      presentation?.visible &&
      rect &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      Math.abs(rect.x - bounds.x) <= 1 &&
      Math.abs(rect.y - bounds.y) <= 1 &&
      Math.abs(rect.width - bounds.width) <= 1 &&
      Math.abs(rect.height - bounds.height) <= 1 &&
      state.presentations.filter((candidate) => candidate.visible).length === 1,
    );
  }, activePane);
}
