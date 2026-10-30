import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { WORKBOARD_CHANGED_EVENT } from "@openclaw/workboard-contract";
import type { Page } from "playwright";
import type { GatewaySessionRow } from "../../ui/src/api/types.ts";
import { pathForWorkboardBoard } from "../../ui/src/app-route-paths.ts";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  defaultControlUiFeatureMethods,
  type ControlUiMockGatewayScenario,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { prepareNativeControlUiPluginFixtures } from "../../ui/src/test-helpers/control-ui-plugin-fixture.ts";
import { workboardUi } from "../../ui/src/test-helpers/control-ui-workboard-fixture.ts";
import type { InteractionEvidence } from "./control-ui-interaction-scenarios.ts";
import type { ControlUiResourceCounts } from "./control-ui-resource-counts.ts";

const totalCards = 1_000;
const pageSize = 100;
const boardId = "resource-cards";
const epoch = "synthetic-workboard-resources";
export const workboardResourceRoute = pathForWorkboardBoard(boardId);

function resourceSessionKey(index: number) {
  return `agent:main:workboard-resource-${index}`;
}

function workboardResourceResponses(count: number, revision: number) {
  const board = {
    id: boardId,
    name: "Resource cards",
    total: count,
    active: count,
    archived: 0,
    byStatus: { ready: count },
  };
  const cards = Array.from({ length: count }, (_, index) => ({
    id: `resource-card-${index}`,
    title: `Resource card ${String(index).padStart(4, "0")}`,
    status: "ready",
    priority: "normal",
    labels: ["Synthetic long resource label", "Another long label", "Third label"],
    position: (index + 1) * 1_000,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_001,
    agentId: "main",
    sessionKey: resourceSessionKey(index),
    metadata: { automation: { boardId } },
  }));
  const page = (offset: number) => {
    const last = cards[offset + pageSize - 1];
    return {
      boards: [board],
      cards: cards.slice(offset, offset + pageSize),
      statuses: ["ready", "done"],
      revision: { epoch, revision, cardsRevision: revision },
      ...(offset + pageSize < count && last
        ? { nextCursor: { position: last.position, createdAt: last.createdAt, id: last.id } }
        : {}),
    };
  };
  return {
    "workboard.boards.list": { boards: [board] },
    "workboard.cards.list": {
      cases: [
        ...Array.from({ length: Math.max(0, Math.ceil(count / pageSize) - 1) }, (_, index) => {
          const offset = (index + 1) * pageSize;
          const previous = cards[offset - 1]!;
          return {
            match: {
              after: {
                position: previous.position,
                createdAt: previous.createdAt,
                id: previous.id,
              },
            },
            response: page(offset),
          };
        }),
        { response: page(0) },
      ],
    },
  };
}

function workboardResourcePlugins(sourceRoot: string) {
  return workboardUi.nativePlugins.map((plugin) => ({
    ...plugin,
    rootDir: path.join(sourceRoot, "extensions/workboard"),
  }));
}

/** Pin the measured plugin source and the exact generation served by the native fixture owner. */
export async function prepareWorkboardResourceSource(directory: string) {
  const root = await realpath(directory);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if ((await realpath(git("rev-parse", "--show-toplevel"))) !== root) {
    throw new Error("Workboard source root must be a Git checkout root");
  }
  const sourcePaths = ["extensions/workboard/browser", "extensions/workboard/package.json"];
  if (git("status", "--porcelain", "--untracked-files=all", "--", ...sourcePaths)) {
    throw new Error(`Workboard benchmark source must be committed and clean: ${root}`);
  }
  const revision = git("rev-parse", "HEAD");
  const browserTree = git("rev-parse", "HEAD:extensions/workboard/browser");
  const { catalog, assets } = await prepareNativeControlUiPluginFixtures(
    workboardResourcePlugins(root),
  );
  return {
    root,
    revision,
    browserTree,
    catalog,
    assets: [...assets]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([url, asset]) => ({
        url,
        bytes: asset.body.length,
        sha256: createHash("sha256").update(asset.body).digest("hex"),
      })),
  };
}

/** Use the compiled native Workboard plugin with an actual paginated card inventory. */
export function createWorkboardResourceFixture(
  buildId: string,
  version: string,
  sourceRoot: string,
) {
  return {
    ...workboardUi,
    nativePlugins: workboardResourcePlugins(sourceRoot),
    serverBuildId: buildId,
    serverVersion: version,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "workboard.boards.list",
      "workboard.cards.list",
      "workboard.cards.update",
    ],
    sessions: Array.from(
      { length: totalCards },
      (_, index) =>
        ({
          key: resourceSessionKey(index),
          agentId: "main",
          sessionId: `workboard-resource-session-${index}`,
          displayName: `Resource session ${index}`,
          kind: "direct",
          updatedAt: 1_800_000_000_001,
          status: "queued",
          hasActiveRun: true,
          activeRunIds: [`resource-run-${index}`],
        }) satisfies GatewaySessionRow,
    ),
    methodResponses: workboardResourceResponses(totalCards, 1),
  } satisfies ControlUiMockGatewayScenario;
}

async function loadAllCards(page: Page, cardCount: number) {
  for (
    let expectedCount = Math.min(pageSize, cardCount);
    expectedCount <= cardCount;
    expectedCount += pageSize
  ) {
    await page.waitForFunction(
      (expected) => document.querySelectorAll(".workboard-card").length === expected,
      expectedCount,
    );
    if (expectedCount < cardCount) {
      await page.getByRole("button", { name: "Load more cards", exact: true }).click();
    }
  }
  await page.waitForFunction(
    (count) => document.querySelectorAll(".workboard-card").length === count,
    cardCount,
  );
}

export async function prepareWorkboardResourceFixture(
  page: Page,
  settle: (page: Page) => Promise<void>,
) {
  await page.locator(".workboard-page-title", { hasText: "Resource cards" }).waitFor();
  await loadAllCards(page, totalCards);
  await page.locator(".workboard-card").first().scrollIntoViewIfNeeded();
  await page.locator(".workboard-page-title > span").hover();
  await settle(page);
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    // SAFETY: The runner installs this known native-counter reader before navigation when enabled.
    const reader = Reflect.get(window, "openclawResourceCounts") as
      | (() => ControlUiResourceCounts)
      | undefined;
    const resources = reader?.();
    return {
      mountedCards: document.querySelectorAll(".workboard-card").length,
      mountedStatuses: document.querySelectorAll("openclaw-workboard-session-status").length,
      mountedStatusTriggers: document.querySelectorAll(".workboard-session-status__trigger").length,
      mountedLabelStrips: document.querySelectorAll(".workboard-card__labels").length,
      mountedMenus: document.querySelectorAll(".workboard-card__action-menu-panel").length,
      openPopovers: document.querySelectorAll(":popover-open").length,
      documentVisible: document.visibilityState === "visible",
      instrumented: Boolean(resources),
      ...(resources
        ? {
            windowListeners: resources.listeners.window,
            documentListeners: resources.listeners.document,
            windowResizeListeners:
              (resources.listenerTypes.window["resize:bubble"] ?? 0) +
              (resources.listenerTypes.window["resize:capture"] ?? 0),
            windowCaptureScrollListeners: resources.listenerTypes.window["scroll:capture"] ?? 0,
            documentCaptureScrollListeners: resources.listenerTypes.document["scroll:capture"] ?? 0,
            documentCapturePointerdownListeners:
              resources.listenerTypes.document["pointerdown:capture"] ?? 0,
            documentCaptureKeydownListeners:
              resources.listenerTypes.document["keydown:capture"] ?? 0,
            windowCallbacks: resources.listenerCallbacks.window,
            documentCallbacks: resources.listenerCallbacks.document,
            activeResizeObservers: resources.observers.ResizeObserver.active,
            resizeTargets: resources.observers.ResizeObserver.targets,
            resizeCallbacks: resources.observers.ResizeObserver.callbacks,
            animationFrameCallbacks: resources.animationFrames.callbacks,
          }
        : {}),
    };
  });
}

async function exerciseNativeToggleCancellation(page: Page, settle: (page: Page) => Promise<void>) {
  const closed = await snapshot(page);
  if (!closed.instrumented) {
    throw new Error("Native Workboard transition proof requires the resource probe");
  }
  const first = page.locator(".workboard-card").first();
  const panelLocator = first.locator(".workboard-card__action-menu-panel");
  const recorder = await panelLocator.evaluateHandle((panel) => {
    const events: Array<{ type: string; trusted: boolean; state: string; prevented: boolean }> = [];
    const state = { cancelOpen: true, events };
    const record = (event: Event) => {
      if (event instanceof ToggleEvent) {
        if (event.type === "beforetoggle" && event.newState === "open" && state.cancelOpen) {
          event.preventDefault();
        }
        state.events.push({
          type: event.type,
          trusted: event.isTrusted,
          state: event.newState,
          prevented: event.defaultPrevented,
        });
      }
    };
    panel.addEventListener("beforetoggle", record);
    panel.addEventListener("toggle", record);
    return {
      state,
      stop: () => {
        panel.removeEventListener("beforetoggle", record);
        panel.removeEventListener("toggle", record);
      },
    };
  });
  try {
    await first.hover();
    await first.locator(".workboard-card__menu-trigger").click();
    await page.waitForFunction(
      ({ state }) =>
        state.events.some(
          (event) =>
            event.type === "beforetoggle" &&
            event.trusted &&
            event.state === "open" &&
            event.prevented,
        ),
      recorder,
    );
    await settle(page);
    const cancelled = await snapshot(page);
    const cancelledPanelOpen = await panelLocator.evaluate((panel) =>
      panel.matches(":popover-open"),
    );
    if (
      cancelledPanelOpen ||
      cancelled.windowResizeListeners !== closed.windowResizeListeners ||
      cancelled.windowCaptureScrollListeners !== closed.windowCaptureScrollListeners
    ) {
      throw new Error(
        `Canceled native menu opening left an open popover or positioning subscription: ${JSON.stringify(
          {
            panelOpen: cancelledPanelOpen,
            before: closed,
            after: cancelled,
            events: await recorder.evaluate(({ state }) => state.events),
          },
        )}`,
      );
    }
    await recorder.evaluate(({ state }) => {
      state.cancelOpen = false;
    });
    await panelLocator.evaluate((panel) => {
      if (!(panel instanceof HTMLElement)) {
        throw new Error("Expected native Workboard menu");
      }
      panel.showPopover();
      panel.hidePopover();
    });
    await page.waitForFunction(
      ({ state }) =>
        state.events.some(
          (event) => event.type === "toggle" && event.trusted && event.state === "closed",
        ),
      recorder,
    );
    await settle(page);
    const coalesced = await snapshot(page);
    const events = await recorder.evaluate(({ state }) => state.events);
    const coalescedPanelOpen = await panelLocator.evaluate((panel) =>
      panel.matches(":popover-open"),
    );
    const recordedOpenToggle = events.some(
      (event) => event.type === "toggle" && event.state === "open",
    );
    if (
      coalescedPanelOpen ||
      coalesced.windowResizeListeners !== closed.windowResizeListeners ||
      coalesced.windowCaptureScrollListeners !== closed.windowCaptureScrollListeners ||
      recordedOpenToggle
    ) {
      throw new Error(
        `Same-task native show/hide did not coalesce to closed without positioning subscriptions: ${JSON.stringify(
          {
            panelOpen: coalescedPanelOpen,
            recordedOpenToggle,
            before: closed,
            after: coalesced,
            events,
          },
        )}`,
      );
    }
    return {
      nativeCancelledOpening: true,
      nativeCoalescedClosed: true,
      nativeToggleEvents: events.length,
      ...workboardEvidence("cancelled", cancelled),
      ...workboardEvidence("coalesced", coalesced),
    };
  } finally {
    try {
      await recorder.evaluate(({ stop }) => stop());
    } finally {
      await recorder.dispose();
    }
  }
}

async function exerciseNativePendingHover(page: Page, cancellationKind: "scroll" | "pointerdown") {
  const first = page.locator(".workboard-card").first();
  const triggerLocator = first.locator(".workboard-session-status__trigger");
  await triggerLocator.scrollIntoViewIfNeeded();
  await page.locator(".workboard-page-title > span").hover();
  const recorder = await triggerLocator.evaluateHandle((trigger, kind) => {
    const host = trigger.closest("openclaw-workboard-session-status");
    const panel = host?.querySelector(".workboard-session-status__popover");
    if (!host || !panel) {
      throw new Error("Expected actual Workboard status surface");
    }
    const state = {
      enteredAt: -1,
      cancelledAt: -1,
      opened: false,
      pointerTrusted: false,
      cancellationTrusted: false,
    };
    const enter = (event: Event) => {
      state.enteredAt = performance.now();
      state.pointerTrusted = event.isTrusted;
    };
    const cancel = (event: Event) => {
      if (state.enteredAt >= 0 && !event.composedPath().includes(host) && state.cancelledAt < 0) {
        state.cancelledAt = performance.now();
        state.cancellationTrusted = event.isTrusted;
      }
    };
    const opening = (event: Event) => {
      if (event instanceof ToggleEvent && event.newState === "open") {
        state.opened = true;
      }
    };
    trigger.addEventListener("pointerenter", enter);
    document.addEventListener(kind, cancel, true);
    panel.addEventListener("beforetoggle", opening);
    return {
      state,
      stop: () => {
        trigger.removeEventListener("pointerenter", enter);
        document.removeEventListener(kind, cancel, true);
        panel.removeEventListener("beforetoggle", opening);
      },
    };
  }, cancellationKind);
  try {
    await triggerLocator.hover();
    if (cancellationKind === "scroll") {
      await page.mouse.wheel(0, 120);
    } else {
      await page.locator(".workboard-page-title > span").click();
    }
    await page.waitForFunction(({ state }) => state.cancelledAt >= 0, recorder);
    const cancellation = await recorder.evaluate(({ state }) => ({ ...state }));
    if (
      !cancellation.pointerTrusted ||
      !cancellation.cancellationTrusted ||
      cancellation.cancelledAt - cancellation.enteredAt >= 350
    ) {
      throw new Error(
        `Pending ${cancellationKind} proof setup did not deliver trusted cancellation before the 350ms native hover deadline`,
      );
    }
    await page.waitForFunction(({ state }) => performance.now() - state.enteredAt > 450, recorder);
    const result = await recorder.evaluate(({ state }) => ({ ...state }));
    if (
      result.opened ||
      (await first
        .locator(".workboard-session-status__popover")
        .evaluate((panel) => panel.matches(":popover-open")))
    ) {
      throw new Error(`Status opened after native pending-hover ${cancellationKind} cancellation`);
    }
    return {
      [`${cancellationKind}HoverCancellationMs`]: result.cancelledAt - result.enteredAt,
      [`${cancellationKind}HoverPointerTrusted`]: result.pointerTrusted,
      [`${cancellationKind}HoverCancellationTrusted`]: result.cancellationTrusted,
      [`${cancellationKind}HoverStayedClosed`]: !result.opened,
    };
  } finally {
    try {
      await recorder.evaluate(({ stop }) => stop());
    } finally {
      await recorder.dispose();
    }
  }
}

function workboardEvidence(
  phase: string,
  state: Awaited<ReturnType<typeof snapshot>>,
): InteractionEvidence {
  const evidence: InteractionEvidence = {
    [`${phase}MountedCards`]: state.mountedCards,
    [`${phase}MountedStatuses`]: state.mountedStatuses,
    [`${phase}MountedStatusTriggers`]: state.mountedStatusTriggers,
    [`${phase}MountedLabelStrips`]: state.mountedLabelStrips,
    [`${phase}MountedMenus`]: state.mountedMenus,
    [`${phase}OpenPopovers`]: state.openPopovers,
    [`${phase}DocumentVisible`]: state.documentVisible,
    [`${phase}Instrumented`]: state.instrumented,
  };
  for (const [name, value] of [
    ["WindowListeners", state.windowListeners],
    ["DocumentListeners", state.documentListeners],
    ["WindowResizeListeners", state.windowResizeListeners],
    ["WindowCaptureScrollListeners", state.windowCaptureScrollListeners],
    ["DocumentCaptureScrollListeners", state.documentCaptureScrollListeners],
    ["DocumentCapturePointerdownListeners", state.documentCapturePointerdownListeners],
    ["DocumentCaptureKeydownListeners", state.documentCaptureKeydownListeners],
    ["WindowCallbacks", state.windowCallbacks],
    ["DocumentCallbacks", state.documentCallbacks],
    ["ActiveResizeObservers", state.activeResizeObservers],
    ["ResizeTargets", state.resizeTargets],
    ["ResizeCallbacks", state.resizeCallbacks],
    ["AnimationFrameCallbacks", state.animationFrameCallbacks],
  ] as const) {
    if (value !== undefined) {
      evidence[`${phase}${name}`] = value;
    }
  }
  return evidence;
}

function assertMounted(state: Awaited<ReturnType<typeof snapshot>>, count: number) {
  if (
    state.mountedCards !== count ||
    state.mountedStatuses !== count ||
    state.mountedStatusTriggers !== count ||
    state.mountedLabelStrips !== count ||
    state.mountedMenus !== count
  ) {
    throw new Error(
      `Expected ${count} actual production Workboard cards/statuses/triggers/labels/menus`,
    );
  }
}

function assertResourceRecovery(
  before: Awaited<ReturnType<typeof snapshot>>,
  retired: Awaited<ReturnType<typeof snapshot>>,
  remounted: Awaited<ReturnType<typeof snapshot>>,
): InteractionEvidence {
  if (
    before.resizeTargets === undefined ||
    retired.resizeTargets === undefined ||
    before.resizeTargets - retired.resizeTargets < totalCards
  ) {
    throw new Error(
      "Retiring all cards did not release at least 1,000 native resize observation targets",
    );
  }
  for (const key of [
    "windowListeners",
    "documentListeners",
    "activeResizeObservers",
    "resizeTargets",
  ] as const) {
    const initial = before[key];
    const afterRetirement = retired[key];
    const afterRemount = remounted[key];
    if (initial === undefined || afterRetirement === undefined || afterRemount === undefined) {
      throw new Error(`Native resource probe did not report ${key} for the lifecycle proof`);
    }
    if (afterRetirement > initial || afterRemount > initial) {
      throw new Error(`Workboard retirement/remount leaked native ${key}`);
    }
  }
  return {
    releasedResizeTargets: before.resizeTargets - retired.resizeTargets,
    nativeResourcesRecovered: true,
  };
}

async function replaceCardWindow(
  page: Page,
  gateway: MockGatewayControls,
  cardCount: number,
  revision: number,
  settle: (page: Page) => Promise<void>,
) {
  const responses = workboardResourceResponses(cardCount, revision);
  await gateway.setMethodResponse("workboard.boards.list", responses["workboard.boards.list"]);
  await gateway.setMethodResponse("workboard.cards.list", responses["workboard.cards.list"]);
  await gateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {
    epoch,
    revision,
    cardsRevision: revision,
  });
  if (cardCount === totalCards) {
    await loadAllCards(page, cardCount);
  } else {
    await page.waitForFunction(
      (count) => document.querySelectorAll(".workboard-card").length === count,
      cardCount,
    );
  }
  await settle(page);
  const state = await snapshot(page);
  assertMounted(state, cardCount);
  return state;
}

/** Probe-required native correctness and lifetime proof; never use its diagnostic waits as CPU timing. */
export async function exerciseWorkboardResourceFixture(
  page: Page,
  gateway: MockGatewayControls,
  settle: (page: Page) => Promise<void>,
): Promise<InteractionEvidence> {
  const mounted = await snapshot(page);
  assertMounted(mounted, totalCards);
  if (!mounted.instrumented) {
    throw new Error("Workboard native resource proof requires --resource-counts");
  }
  const inputCapabilities = await page.evaluate(() => ({
    nativeMaxTouchPoints: navigator.maxTouchPoints,
    nativePrimaryPointerCoarse: matchMedia("(pointer: coarse)").matches,
    nativePrimaryHoverNone: matchMedia("(hover: none)").matches,
  }));
  const nativeTransitions = await exerciseNativeToggleCancellation(page, settle);
  const pendingHoverScroll = await exerciseNativePendingHover(page, "scroll");
  const pendingHoverPointer = await exerciseNativePendingHover(page, "pointerdown");
  const first = page.locator(".workboard-card").first();
  const menuEvents = await first
    .locator(".workboard-card__action-menu-panel")
    .evaluateHandle((panel) => {
      const events: Array<{ type: string; trusted: boolean; newState: string }> = [];
      const record = (event: Event) => {
        if (event instanceof ToggleEvent) {
          events.push({ type: event.type, trusted: event.isTrusted, newState: event.newState });
        }
      };
      panel.addEventListener("beforetoggle", record);
      panel.addEventListener("toggle", record);
      return {
        events,
        stop: () => {
          panel.removeEventListener("beforetoggle", record);
          panel.removeEventListener("toggle", record);
        },
      };
    });
  try {
    await first.hover();
    await first.locator(".workboard-card__menu-trigger").click();
    await first.locator(".workboard-card__action-menu-panel:popover-open").waitFor();
    await page.waitForFunction(
      ({ events }) =>
        events.some(
          (event) => event.type === "beforetoggle" && event.trusted && event.newState === "open",
        ) &&
        events.some(
          (event) => event.type === "toggle" && event.trusted && event.newState === "open",
        ),
      menuEvents,
    );
  } finally {
    try {
      await menuEvents.evaluate(({ stop }) => stop());
    } finally {
      await menuEvents.dispose();
    }
  }
  const menuOpen = await snapshot(page);
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Workboard native proof requires a bounded viewport");
  }
  try {
    await page.setViewportSize({ ...viewport, width: viewport.width + 64 });
    await settle(page);
    const menuPositioned = await first
      .locator(".workboard-card__action-menu-panel")
      .evaluate((panel) => {
        const bounds = panel.getBoundingClientRect();
        const trigger = panel.previousElementSibling?.getBoundingClientRect();
        return Boolean(
          trigger &&
          bounds.left >= 11 &&
          bounds.right <= innerWidth - 11 &&
          Math.abs(bounds.top - trigger.bottom - 6) <= 1,
        );
      });
    if (!menuPositioned) {
      throw new Error("Open Workboard menu lost actual viewport positioning");
    }
    await page.keyboard.press("Escape");
    await first
      .locator(".workboard-card__action-menu-panel:popover-open")
      .waitFor({ state: "hidden" });
    await first.locator(".workboard-session-status__trigger").click();
    await first.locator(".workboard-session-status__popover:popover-open").waitFor();
    const statusOpen = await snapshot(page);
    await page.keyboard.press("Escape");
    await first
      .locator(".workboard-session-status__popover:popover-open")
      .waitFor({ state: "hidden" });
    // Park pointer/focus and wait for the existing 150ms leave deadline through native counts.
    await page.locator(".workboard-page-title > span").click();
    try {
      await page.waitForFunction((expected) => {
        const read = Reflect.get(window, "openclawResourceCounts");
        if (typeof read !== "function") {
          throw new Error("Native resource probe disappeared");
        }
        // SAFETY: The collector installs this counter schema before navigation.
        const resources = read() as ControlUiResourceCounts;
        return (
          document.querySelectorAll(":popover-open").length === 0 &&
          (resources.listenerTypes.window["resize:bubble"] ?? 0) +
            (resources.listenerTypes.window["resize:capture"] ?? 0) ===
            expected.windowResizeListeners &&
          (resources.listenerTypes.window["scroll:capture"] ?? 0) ===
            expected.windowCaptureScrollListeners &&
          (resources.listenerTypes.document["scroll:capture"] ?? 0) ===
            expected.documentCaptureScrollListeners &&
          (resources.listenerTypes.document["pointerdown:capture"] ?? 0) ===
            expected.documentCapturePointerdownListeners &&
          (resources.listenerTypes.document["keydown:capture"] ?? 0) ===
            expected.documentCaptureKeydownListeners
        );
      }, mounted);
    } catch (error) {
      throw new Error(
        `Closed Workboard popovers did not retire positioning and status listeners: ${JSON.stringify(
          {
            before: mounted,
            after: await snapshot(page),
          },
        )}`,
        { cause: error },
      );
    }
    await settle(page);
    const closed = await snapshot(page);
    const evidence: InteractionEvidence = {
      nativePopoverBehavior: true,
      nativeMenuPositioned: menuPositioned,
      ...inputCapabilities,
      ...nativeTransitions,
      ...pendingHoverScroll,
      ...pendingHoverPointer,
      ...workboardEvidence("mounted", mounted),
      ...workboardEvidence("menuOpen", menuOpen),
      ...workboardEvidence("statusOpen", statusOpen),
      ...workboardEvidence("closed", closed),
    };
    const half = await replaceCardWindow(page, gateway, 500, 2, settle);
    const retired = await replaceCardWindow(page, gateway, 0, 3, settle);
    const remounted = await replaceCardWindow(page, gateway, totalCards, 4, settle);
    return {
      ...evidence,
      ...workboardEvidence("half", half),
      ...workboardEvidence("retired", retired),
      ...workboardEvidence("remounted", remounted),
      ...assertResourceRecovery(closed, retired, remounted),
    };
  } finally {
    await page.setViewportSize(viewport);
  }
}

/** Fixed native resize/scroll work, without probe readers beyond snapshots or diagnostic event listeners. */
export async function runWorkboardEventsCpu(
  page: Page,
  settle: (page: Page) => Promise<void>,
): Promise<InteractionEvidence> {
  const before = await snapshot(page);
  assertMounted(before, totalCards);
  if (before.openPopovers) {
    throw new Error("Closed-card CPU fixture has an open popover");
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Workboard CPU fixture requires a bounded viewport");
  }
  const cards = page
    .locator(".workboard-column__cards")
    .filter({ has: page.locator(".workboard-card") })
    .first();
  const bounds = await cards.boundingBox();
  if (
    !bounds ||
    !(await cards.evaluate((element) => element.scrollHeight - element.clientHeight > 160))
  ) {
    throw new Error("Workboard CPU fixture did not expose its real scrollable card column");
  }
  const initialTop = await cards.evaluate((element) => element.scrollTop);
  let scrollChanges = 0;
  try {
    for (let step = 0; step < 8; step++) {
      await page.setViewportSize({
        ...viewport,
        width: viewport.width + (step % 2 === 0 ? 64 : 0),
      });
      const previousTop = await cards.evaluate((element) => element.scrollTop);
      const scrollBounds = await cards.boundingBox();
      if (!scrollBounds) {
        throw new Error("Workboard card column disappeared during native resize");
      }
      await page.mouse.move(scrollBounds.x + scrollBounds.width - 4, scrollBounds.y + 20);
      await page.mouse.wheel(0, step % 2 === 0 ? 120 : -120);
      await page.waitForFunction(
        ({ selector, prior }) => {
          const columns = [...document.querySelectorAll(selector)];
          return columns.some(
            (element) => element.querySelector(".workboard-card") && element.scrollTop !== prior,
          );
        },
        { selector: ".workboard-column__cards", prior: previousTop },
      );
      await settle(page);
      scrollChanges++;
    }
    const after = await snapshot(page);
    assertMounted(after, totalCards);
    if (after.openPopovers) {
      throw new Error("Native closed-card workload unexpectedly opened a popover");
    }
    return {
      nativeViewportChanges: 8,
      nativeCardColumnScrollChanges: scrollChanges,
      ...workboardEvidence("before", before),
      ...workboardEvidence("after", after),
    };
  } finally {
    await page.setViewportSize(viewport);
    await cards.evaluate((element, top) => {
      element.scrollTop = top;
    }, initialTop);
  }
}

/** Measure retirement plus actual paginated remount inside the runner's CPU interval. */
export async function runWorkboardRemountCpu(
  page: Page,
  gateway: MockGatewayControls,
  settle: (page: Page) => Promise<void>,
): Promise<InteractionEvidence> {
  const before = await snapshot(page);
  assertMounted(before, totalCards);
  const retired = await replaceCardWindow(page, gateway, 0, 2, settle);
  const remounted = await replaceCardWindow(page, gateway, totalCards, 3, settle);
  return {
    retiredThenRemounted: true,
    ...workboardEvidence("before", before),
    ...workboardEvidence("retired", retired),
    ...workboardEvidence("remounted", remounted),
  };
}

/** The collector owns native window hiding; never override visibility or await RAF while hidden. */
export async function idleWorkboardResourceFixture(
  page: Page,
  visibility: "visible" | "hidden",
): Promise<InteractionEvidence> {
  const before = await snapshot(page);
  assertMounted(before, totalCards);
  if (before.documentVisible !== (visibility === "visible")) {
    throw new Error(`Expected genuinely ${visibility} Workboard before idle`);
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 3_000);
  });
  const after = await snapshot(page);
  assertMounted(after, totalCards);
  if (after.documentVisible !== before.documentVisible) {
    throw new Error("Workboard visibility changed during idle");
  }
  return {
    idleMs: 3_000,
    ...workboardEvidence("before", before),
    ...workboardEvidence("after", after),
  };
}
