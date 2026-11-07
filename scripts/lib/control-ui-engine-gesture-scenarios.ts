import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createEngineTranscript, type EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import {
  createEnginePageScenarios,
  enginePageFixtureCounts,
} from "./control-ui-engine-page-scenarios.ts";
import { frames, navigation } from "./control-ui-interaction-navigation.ts";
import type { InteractionEvidence } from "./control-ui-interaction-scenarios.ts";

const sessionKeys = ["agent:main:interaction-a", "agent:main:interaction-b"] as const;
const pane = ".chat-pane-cache__pane--active";
const thread = `${pane} .chat-thread`;
const samples = 90;
const intervalMs = 1_000 / 60;

/** Pace trusted driver input rather than dispatching a burst of synthetic DOM events. */
async function pacedInput(
  input: (index: number) => Promise<void>,
  serial = false,
): Promise<InteractionEvidence> {
  const started = performance.now();
  const intervals: number[] = [];
  const deliveries: Promise<void>[] = [];
  let failure: Error | undefined;
  let previousSend: number | undefined;
  for (let index = 0; index < samples; index++) {
    let wait = (previousSend ?? started - intervalMs) + intervalMs - performance.now();
    while (wait > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, wait);
      });
      wait = (previousSend ?? started - intervalMs) + intervalMs - performance.now();
    }
    const sentAt = performance.now();
    if (previousSend !== undefined) {
      intervals.push(sentAt - previousSend);
    }
    previousSend = sentAt;
    // A physical device does not await the renderer's acknowledgement. Keep
    // native commands ordered at the device rate, then drain before releasing.
    const delivery = input(index).catch((error: unknown) => {
      failure ??= error instanceof Error ? error : new Error(String(error));
    });
    if (serial) {
      // Viewport commands reconfigure the driver and cannot overlap in Firefox.
      await delivery;
    } else {
      deliveries.push(delivery);
    }
  }
  await Promise.all(deliveries);
  if (failure) {
    throw failure;
  }
  const duration = performance.now() - started;
  const sorted = intervals.toSorted((left, right) => left - right);
  return {
    inputSamples: samples,
    inputDurationMs: duration,
    requestedInputHz: 60,
    driverIntervalMinMs: sorted[0]!,
    driverIntervalMedianMs: sorted[Math.floor(sorted.length / 2)]!,
    driverIntervalP95Ms: sorted[Math.floor(sorted.length * 0.95)]!,
    driverIntervalMaxMs: sorted.at(-1)!,
  };
}

async function bounds(locator: Locator) {
  await locator.waitFor({ state: "visible" });
  const box = await locator.boundingBox();
  assert(box && box.width > 0 && box.height > 0, "Gesture target must have a visible box");
  const viewport = locator.page().viewportSize()!;
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  return {
    x: left,
    y: top,
    width: Math.min(box.x + box.width, viewport.width) - left,
    height: Math.min(box.y + box.height, viewport.height) - top,
  };
}

async function sweep(page: Page, target: Locator) {
  const box = await bounds(target);
  const evidence = await pacedInput(async (index) => {
    const fraction = index / (samples - 1);
    const x = box.x + box.width * (0.15 + 0.7 * ((index % 20) / 19));
    await page.mouse.move(x, box.y + 4 + fraction * (box.height - 8));
  });
  return { ...evidence, pointerMoves: samples };
}

async function wheel(page: Page, target: Locator) {
  const box = await bounds(target);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await target.evaluate((element) => element.scrollTop);
  const evidence = await pacedInput(async () => page.mouse.wheel(0, 32));
  await frames(page);
  const after = await target.evaluate((element) => element.scrollTop);
  assert(after > before, "Native wheel input must advance the owning scrollport");
  return { ...evidence, wheelEvents: samples, scrollDistance: after - before };
}

function chatScenario(size: "realistic" | "large"): EngineScenario {
  const count = size === "large" ? 2_000 : 100;
  const sessions = size === "large" ? 1_000 : 100;
  return {
    id: `gesture-chat-${size}`,
    route: controlUiSessionPath(sessionKeys[0]),
    explicitOnly: true,
    fixture: { longSessionLabels: true },
    fixtureOverrides: (_sandbox, base) => ({
      sessions: base.sessions.slice(0, sessions),
      sessionTranscripts: Object.fromEntries(
        sessionKeys.map((key) => [key, { messages: createEngineTranscript(count) }]),
      ),
    }),
    expected: `${count} synthetic messages and ${sessions} sessions remain available throughout the gesture.`,
    prepare: async (page) => {
      await page.locator(pane).waitFor();
      assert.equal(await page.locator(pane).count(), 1, "Exactly one pane owns active input");
      await page
        .locator(pane)
        .getByText(`Transcript 0 message ${count - 1}.`, { exact: false })
        .waitFor();
      await page.locator(`${pane} .agent-chat__composer-combobox textarea`).waitFor();
      await frames(page);
    },
    run: async () => {},
  };
}

async function prepareTop(page: Page, selector: string) {
  // Positioning belongs to setup. Measured scrolling below always uses native wheel input.
  await page
    .locator(selector)
    .evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
  await frames(page);
}

async function expandSidebar(page: Page, gateway: MockGatewayControls, count: number) {
  const rosterMore = page.locator(
    ".sidebar-session-pagination--roster > .sidebar-session-pagination__button",
  );
  for (let offset = 200; offset < count; offset += 200) {
    await rosterMore.click();
    await gateway.waitForRequest("sessions.list", {
      match: { source: "sidebar", offset, limit: 200 },
    });
    await frames(page);
  }
  const more = page.locator('.sidebar-session-pagination__button[aria-label="Show more"]:visible');
  for (let index = 0; index < 100 && (await more.count()) > 0; index++) {
    await more.first().click();
    await frames(page);
  }
  assert.equal(await more.count(), 0, "Every loaded sidebar row must be available to scroll");
}

async function prepareSessions(page: Page, count: number) {
  await page.locator(".sessions-table tbody .session-data-row").first().waitFor();
  const toggle = page.getByRole("button", { name: "Filters", exact: true });
  await toggle.click();
  const filters = page.locator(".sessions-filter-popover:popover-open");
  await filters.getByLabel("Limit", { exact: true }).fill(String(count));
  await filters.getByLabel("Limit", { exact: true }).press("Tab");
  await page
    .locator(".data-table-pagination__info")
    .getByText(new RegExp(String(count)))
    .waitFor();
  if ((await filters.getAttribute("aria-modal")) === "true") {
    await filters.locator(".oc-sheet__close").click();
  } else {
    await toggle.click();
  }
  await filters.waitFor({ state: "hidden" });
  await page.locator(".data-table-pagination__size").selectOption("100");
  await frames(page);
}

function splitSettings(): NonNullable<EngineScenario["settings"]> {
  return {
    chatSplitLayout: {
      activePaneId: "gesture-pane-0",
      // The active pane must initially fit both conversation and Review; the
      // window-resize gesture then exercises its actual narrow transition.
      columnWeights: [0.7, 0.3],
      columns: sessionKeys.map((sessionKey, index) => ({
        id: `gesture-column-${index}`,
        paneWeights: [1],
        panes: [{ id: `gesture-pane-${index}`, sessionKey }],
      })),
    },
    sidebarSessionLayouts: {
      [sessionKeys[0]]: {
        dock: "right",
        open: true,
        columns: [
          {
            id: "gesture-detail-column",
            side: "right",
            width: 320,
            height: 320,
            activePanelId: "gesture-detail",
            panels: [{ id: "gesture-detail", slot: "detail" }],
          },
        ],
      },
    },
  };
}

function splitFixture(base: EngineScenario): Pick<EngineScenario, "settings" | "fixtureOverrides"> {
  return {
    settings: splitSettings(),
    fixtureOverrides: (sandbox, fixture) => ({
      ...base.fixtureOverrides?.(sandbox, fixture),
      workspace: "/workspace/synthetic-gestures",
      workspaceGit: true,
      featureMethods: ["sessions.diff"],
      methodResponses: {
        "sessions.diff": {
          sessionKey: sessionKeys[0],
          root: "/workspace/synthetic-gestures",
          additions: 20,
          deletions: 20,
          files: Array.from({ length: 20 }, (_, index) => ({
            path: `src/gesture-${index}.ts`,
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: `@@ -1 +1 @@\n-export const value = ${index};\n+export const value = ${index + 1};`,
          })),
        },
      },
    }),
  };
}

/** Continuous input only; route loading and fixture positioning finish in prepare. */
export function createEngineGestureScenarios(): readonly EngineScenario[] {
  const scenarios: EngineScenario[] = [];
  const settings = createEnginePageScenarios().find(({ id }) => id === "page-advanced-visit")!;
  for (const size of ["realistic", "large"] as const) {
    const base = chatScenario(size);
    const count = size === "large" ? 1_000 : 100;
    for (const surface of ["sidebar", "transcript", "settings", "sessions"] as const) {
      for (const action of ["sweep", "wheel"] as const) {
        const selector =
          surface === "sidebar"
            ? ".sidebar-shell__body"
            : surface === "transcript"
              ? thread
              : surface === "sessions"
                ? ".data-table-container"
                : ".content";
        scenarios.push({
          ...base,
          id: `gesture-${surface}-${action}-${size}`,
          // Mobile WebKit has no wheel implementation; touch has different semantics.
          // Hover sweeps likewise describe a desktop pointer, not a finger gesture.
          viewports: ["desktop"],
          route:
            surface === "sessions"
              ? "/sessions"
              : surface === "settings"
                ? "/settings/advanced"
                : base.route,
          ...(surface === "settings"
            ? {
                fixtureOverrides: (sandbox, fixture) => {
                  const overrides = settings.fixtureOverrides?.(sandbox, fixture);
                  return {
                    ...overrides,
                    ...base.fixtureOverrides?.(sandbox, fixture),
                    methodResponses: overrides?.methodResponses,
                  };
                },
              }
            : {}),
          expected: `A paced native ${action} traverses the ${surface} without activating controls. ${base.expected}`,
          prepare: async (page, gateway) => {
            if (surface === "sessions") {
              await prepareSessions(page, count);
            } else if (surface === "settings") {
              await page.waitForFunction(
                (minimum) =>
                  document.querySelectorAll("openclaw-config-page .settings-row").length >= minimum,
                enginePageFixtureCounts.advancedRows,
              );
            } else {
              await base.prepare(page, gateway);
              if (surface === "sidebar") {
                await navigation(page, "sessions");
                await expandSidebar(page, gateway, count);
              }
            }
            if (action === "wheel") {
              await prepareTop(page, selector);
            }
          },
          run: async (page) =>
            action === "wheel"
              ? wheel(page, page.locator(selector).first())
              : sweep(page, page.locator(selector).first()),
        });
      }
    }
    scenarios.push({
      ...base,
      id: `gesture-transcript-selection-${size}`,
      viewports: ["desktop"],
      expected:
        "Native text selection crosses the initially mounted transcript window; a cross-message range has no single-source popup.",
      prepare: async (page, gateway) => {
        await base.prepare(page, gateway);
        await prepareTop(page, thread);
      },
      run: async (page) => {
        const target = page.locator(thread);
        const box = await bounds(target);
        const text = target
          .locator(".chat-virtual-row:not([data-prepared-row]) .chat-text")
          .filter({ visible: true })
          .first();
        const start = await bounds(text);
        const initial = await target
          .locator(".chat-virtual-row:not([data-prepared-row])")
          .evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-index"))));
        assert(initial.length > 0 && initial.every(Number.isFinite));
        await page.mouse.move(start.x + 8, start.y + 8);
        await page.mouse.down();
        let evidence: InteractionEvidence;
        try {
          evidence = await pacedInput(async (index) => {
            const y = Math.min(box.y + box.height - 4, start.y + 8 + index * 14);
            await page.mouse.move(start.x + Math.min(start.width - 8, 120), y);
            if (index > samples / 3) {
              await page.mouse.wheel(0, 32);
            }
          });
        } finally {
          await page.mouse.up();
        }
        await frames(page);
        const selection = await page.evaluate(() => window.getSelection()?.toString() ?? "");
        const selectedMessages = [...selection.matchAll(/Transcript 0 message (\d+)\./g)].map(
          (match) => Number(match[1]),
        );
        assert(selectedMessages.length > 1, "Selection must span multiple message rows");
        const beyondInitialWindow = Math.max(...selectedMessages) > Math.max(...initial);
        assert(beyondInitialWindow, "Selection must cross the initial virtual window boundary");
        assert.equal(await page.getByRole("toolbar", { name: "Selection actions" }).count(), 0);
        return {
          ...evidence,
          selectedMessages: selectedMessages.length,
          crossedVirtualBoundary: true,
          popupVisible: false,
        };
      },
    });
    scenarios.push({
      ...base,
      id: `gesture-transcript-selection-popup-${size}`,
      viewports: ["desktop"],
      expected:
        "A paced selection within one message opens the single-source Selection actions toolbar.",
      run: async (page) => {
        const target = page.locator(thread).locator(".chat-text").filter({ visible: true }).last();
        const box = await bounds(target);
        await page.mouse.move(box.x + 4, box.y + 8);
        await page.mouse.down();
        let evidence: InteractionEvidence;
        try {
          evidence = await pacedInput((index) =>
            page.mouse.move(
              box.x + 4 + (Math.min(box.width - 12, 200) * index) / (samples - 1),
              box.y + 8,
            ),
          );
        } finally {
          await page.mouse.up();
        }
        await page.getByRole("toolbar", { name: "Selection actions" }).waitFor();
        const selectedCharacters = await page.evaluate(
          () => window.getSelection()?.toString().length ?? 0,
        );
        assert(selectedCharacters > 0);
        return { ...evidence, selectedCharacters, popupVisible: true };
      },
    });
    for (const handle of ["sidebar", "split"] as const) {
      scenarios.push({
        ...base,
        id: `gesture-${handle}-resize-${size}`,
        viewports: ["desktop"],
        ...(handle === "split" ? splitFixture(base) : {}),
        expected: `The ${handle} handle follows a 60 Hz native drag and finishes 35 pixels from its initial position.`,
        run: async (page) => {
          const target =
            handle === "sidebar"
              ? page.getByRole("separator", { name: "Resize sidebar", exact: true })
              : page.locator(".chat-split-view resizable-divider").first();
          const box = await bounds(target);
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          let evidence: InteractionEvidence;
          try {
            evidence = await pacedInput((index) =>
              page.mouse.move(
                x +
                  (Math.sin((index / (samples - 1)) * Math.PI * 2) +
                    (0.5 * index) / (samples - 1)) *
                    70,
                y,
              ),
            );
          } finally {
            await page.mouse.up();
          }
          await frames(page);
          const after = await bounds(target);
          assert(
            Math.abs(after.x - box.x - 35) <= 3,
            "The drag must change the separator position by 35 pixels",
          );
          assert.equal(
            await target.evaluate((element) => element.classList.contains("dragging")),
            false,
          );
          return {
            ...evidence,
            pointerMoves: samples,
            draggingReleased: true,
            separatorDisplacement: after.x - box.x,
          };
        },
      });
    }
    scenarios.push(
      {
        ...base,
        id: `gesture-window-resize-${size}`,
        ...splitFixture(base),
        viewports: ["desktop"],
        expected:
          "Native viewport resizing crosses responsive breakpoints with split and Details state retained.",
        run: async (page) => {
          const original = page.viewportSize()!;
          const evidence = await pacedInput(
            (index) =>
              page.setViewportSize({
                width: Math.round(
                  original.width -
                    (original.width - 580) * Math.sin((index / (samples - 1)) * Math.PI),
                ),
                height: original.height,
              }),
            true,
          );
          await frames(page);
          assert.equal(await page.locator(".chat-split-view__cell").count(), 2);
          await page.locator(`${pane} [data-panel-slot="detail"]`).waitFor({ state: "visible" });
          return { ...evidence, viewportUpdates: samples, retainedPanes: 2, detailsVisible: true };
        },
      },
      {
        ...base,
        id: `gesture-mobile-rotation-${size}`,
        ...splitFixture(base),
        viewports: ["mobile"],
        expected:
          "Six portrait-to-landscape-to-portrait viewport changes retain both split panes and a usable conversation; this does not emulate a device orientation event.",
        run: async (page) => {
          const original = page.viewportSize()!;
          for (let cycle = 0; cycle < 6; cycle++) {
            await page.setViewportSize({ width: original.height, height: original.width });
            await new Promise((resolve) => {
              setTimeout(resolve, 200);
            });
            await page.setViewportSize(original);
            await new Promise((resolve) => {
              setTimeout(resolve, 200);
            });
          }
          await frames(page);
          await page
            .locator(`${pane} .agent-chat__composer-combobox textarea`)
            .waitFor({ state: "visible" });
          assert.equal(await page.locator(".chat-split-view__cell").count(), 2);
          return {
            viewportUpdates: 12,
            rotationCycles: 6,
            composerVisible: true,
            retainedPanes: 2,
          };
        },
      },
    );
  }
  return scenarios;
}
