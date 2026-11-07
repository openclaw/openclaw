import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames, navigation, openNavigationDrawer } from "./control-ui-interaction-navigation.ts";
import {
  cronLoadedJobCount,
  interactionScenarios,
  type InteractionEvidence,
} from "./control-ui-interaction-scenarios.ts";
import { createNoopOwnerScenarios } from "./control-ui-noop-owner-scenarios.ts";
import { createNoopPushScenarios } from "./control-ui-noop-push-scenarios.ts";

const providerArtworkPath = "/__openclaw__/provider-icon/example";
const providerPicker = ".model-providers__defaults openclaw-select-picker";
const providerArtworkRequests = new WeakMap<Page, { count: number }>();

function installProviderArtworkProbe(pathname: string) {
  const blobs = new WeakSet<Blob>();
  const urls = new Set<string>();
  const counts = { blobs: 0, objectUrls: 0, revokedUrls: 0 };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (new URL(response.url, location.href).pathname === pathname) {
      const originalBlob = response.blob.bind(response);
      response.blob = async () => {
        const blob = await originalBlob();
        blobs.add(blob);
        counts.blobs++;
        return blob;
      };
    }
    return response;
  };
  const originalCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (object) {
    const url = originalCreate(object);
    if (object instanceof Blob && blobs.has(object)) {
      urls.add(url);
      counts.objectUrls++;
    }
    return url;
  };
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function (url) {
    if (urls.delete(url)) {
      counts.revokedUrls++;
    }
    originalRevoke(url);
  };
  window.openclawProviderArtworkProbe = () => ({ ...counts, liveUrls: urls.size });
}

async function providerArtworkCounts(page: Page) {
  const counts = await page.evaluate(() => window.openclawProviderArtworkProbe!());
  return { requests: providerArtworkRequests.get(page)!.count, ...counts };
}

async function waitForProviderArtwork(page: Page, isFiltered: boolean) {
  await page.waitForFunction(
    ({ selector, filtered }) => {
      const picker = document.querySelector(selector);
      const rows = [
        ...(picker?.querySelectorAll<HTMLElement>('[data-value^="example/model-"]') ?? []),
      ].filter((row) => row.checkVisibility());
      const images = [...(picker?.querySelectorAll<HTMLImageElement>("img") ?? [])];
      return (
        (filtered ? rows.length === 1 : rows.length > 1) &&
        rows.every((row) => {
          const image = row.querySelector("img");
          return image?.complete && image.naturalWidth > 0;
        }) &&
        images.every((image) => image.complete && image.naturalWidth > 0)
      );
    },
    { selector: providerPicker, filtered: isFiltered },
  );
}

function createProviderArtworkScenario(
  modelCount = 1_000,
  phase: "cycles" | "open" | "reopen" = "cycles",
): EngineScenario {
  const source = interactionScenarios.find(({ id }) => id === "provider-model-picker-first-open");
  const search = interactionScenarios.find(({ id }) => id === "provider-model-picker-search");
  if (!source || !search) {
    throw new Error("Missing shared provider picker scenarios");
  }
  const close = async (page: Page) => {
    const picker = page.locator(providerPicker).first();
    const input = picker.locator(".picker-select__search");
    if (await input.isVisible()) {
      await input.press("Escape");
      await input.waitFor({ state: "hidden" });
    }
    if (
      (await picker.locator(".picker-select__trigger").getAttribute("aria-expanded")) === "true"
    ) {
      await page.keyboard.press("Escape");
    }
    await page.waitForFunction((selector) => {
      const element = document.querySelector(selector);
      const button = element?.querySelector(".picker-select__trigger");
      return (
        button?.getAttribute("aria-expanded") === "false" &&
        button === document.activeElement &&
        element?.querySelectorAll('[role="option"]').length === 0
      );
    }, providerPicker);
  };
  return {
    ...source,
    id: `provider-model-picker-artwork-${phase}${modelCount === 1_000 ? "" : `-${modelCount}`}`,
    explicitOnly: true,
    diagnostic:
      phase === "cycles"
        ? "Counts provider artwork HTTP reads, blob reads and object URLs; not timing proof."
        : undefined,
    expected: `The ${modelCount}-model picker loads shared synthetic provider artwork without saving or changing selection.`,
    initScript:
      phase === "cycles"
        ? `;(() => { const __name = (fn) => fn; (${installProviderArtworkProbe.toString()})(${JSON.stringify(providerArtworkPath)}); })();`
        : undefined,
    fixtureOverrides: (_sandbox, base) => {
      const presentation = {
        providerName: "Synthetic Workstation",
        providerIcon: { source: "asset" as const, url: `${providerArtworkPath}?v=census` },
      };
      const models = base.models
        .slice(-modelCount)
        .map((model) => Object.assign({}, model, presentation));
      return {
        models,
        methodResponses: {
          "models.list": { models, providerPresentations: { example: presentation } },
        },
      };
    },
    setup: async (page) => {
      const requests = { count: 0 };
      providerArtworkRequests.set(page, requests);
      await page.route(`**${providerArtworkPath}?v=census`, async (route) => {
        requests.count++;
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#3879df"/></svg>',
        });
      });
    },
    prepare: async (page, gateway) => {
      await source.prepare?.(page, gateway);
      if (phase === "reopen") {
        await source.run(page, gateway);
        await waitForProviderArtwork(page, false);
        await close(page);
      }
    },
    run: async (page, gateway): Promise<InteractionEvidence> => {
      const picker = page.locator(providerPicker).first();
      const trigger = picker.locator(".picker-select__trigger");
      const selected = await trigger.getAttribute("aria-label");
      const saves = (await gateway.getRequests("config.patch")).length;
      if (phase !== "cycles") {
        await source.run(page, gateway);
        await waitForProviderArtwork(page, false);
        assert.equal(await trigger.getAttribute("aria-label"), selected);
        assert.equal((await gateway.getRequests("config.patch")).length, saves);
        return { modelCount, uniqueImages: 1, renderedImages: await picker.locator("img").count() };
      }
      const before = await providerArtworkCounts(page);
      await source.run(page, gateway);
      await waitForProviderArtwork(page, false);
      const opened = await providerArtworkCounts(page);
      await search.run(page, gateway);
      await waitForProviderArtwork(page, true);
      assert.equal(
        await picker.locator('[role="option"]:visible').first().getAttribute("data-value"),
        "example/model-999",
      );
      const filtered = await providerArtworkCounts(page);
      await close(page);
      await source.run(page, gateway);
      await waitForProviderArtwork(page, false);
      const reopened = await providerArtworkCounts(page);
      await close(page);
      await frames(page);
      const closed = await providerArtworkCounts(page);
      assert.equal(await trigger.getAttribute("aria-label"), selected);
      assert.equal((await gateway.getRequests("config.patch")).length, saves);
      return {
        modelCount,
        uniqueImages: 1,
        openRequests: opened.requests - before.requests,
        filterRequests: filtered.requests - opened.requests,
        reopenRequests: reopened.requests - filtered.requests,
        openBlobReads: opened.blobs - before.blobs,
        filterBlobReads: filtered.blobs - opened.blobs,
        reopenBlobReads: reopened.blobs - filtered.blobs,
        blobReads: closed.blobs - before.blobs,
        objectUrls: closed.objectUrls - before.objectUrls,
        revokedUrls: closed.revokedUrls - before.revokedUrls,
        liveUrlsBefore: before.liveUrls,
        liveUrlsAfter: closed.liveUrls,
        selectionPreserved: true,
        saved: false,
      };
    },
  };
}

declare global {
  interface Window {
    openclawProviderArtworkProbe?: () => {
      blobs: number;
      objectUrls: number;
      revokedUrls: number;
      liveUrls: number;
    };
  }
}

/** Fixed work spans WebKit's coarse CPU samples; probes also count hot-path operations. */
export function createEngineActionScenarios(): readonly EngineScenario[] {
  const cron = interactionScenarios.find(({ id }) => id === "cron-search-typing-pending");
  const cronSearch = interactionScenarios.find(({ id }) => id === "cron-search");
  if (!cron || !cronSearch) {
    throw new Error("Missing shared Cron scenarios");
  }
  const cycles = 8;
  const chatPicker = interactionScenarios.find(({ id }) => id === "model-picker-first-open-search");
  const chatSearch = interactionScenarios.find(({ id }) => id === "model-picker-search");
  const sessions = interactionScenarios.find(({ id }) => id === "sessions-sort");
  const sidebar = interactionScenarios.find(({ id }) => id === "sidebar-toggle");
  if (!chatPicker || !chatSearch || !sessions || !sidebar) {
    throw new Error("Missing shared chat picker or Sessions scenario");
  }
  const repeated = (
    [
      [
        "provider-model-picker-open-search",
        "provider-model-picker-cycles",
        "Eight complete picker search/dismiss cycles retain selection and return focus.",
      ],
      [
        "session-switch",
        "session-switch-cycles",
        "Eight round trips reveal both retained 400-message transcripts each time.",
      ],
      [
        "sidebar-toggle",
        "sidebar-toggle-cycles",
        "Eight sidebar close/open cycles retain the selected session and drawer focus.",
      ],
    ] as const
  ).map(([sourceId, id, expected]) => {
    const scenario = interactionScenarios.find((entry) => entry.id === sourceId);
    if (!scenario) {
      throw new Error(`Missing shared scenario: ${sourceId}`);
    }
    const run: EngineScenario["run"] = async (page, gateway) => {
      for (let cycle = 0; cycle < cycles; cycle++) {
        await scenario.run(page, gateway);
      }
      return { cycles };
    };
    return Object.assign({}, scenario, {
      id,
      expected,
      explicitOnly: true,
      run,
    });
  });
  return [
    createProviderArtworkScenario(),
    createProviderArtworkScenario(12),
    createProviderArtworkScenario(12, "open"),
    createProviderArtworkScenario(12, "reopen"),
    createProviderArtworkScenario(1_000, "open"),
    createProviderArtworkScenario(1_000, "reopen"),
    ...createNoopPushScenarios(),
    ...createNoopOwnerScenarios(),
    ...(["first-open", "open"] as const).map((phase): EngineScenario =>
      Object.assign({}, chatPicker, {
        id: `model-picker-${phase}`,
        explicitOnly: true,
        expected: "One activation opens the model picker with visible choices and focused search.",
        prepare: async (page, gateway) => {
          await chatPicker.prepare(page, gateway);
          if (phase === "open") {
            await page.locator(".chat-pane-cache__pane--active [data-chat-model-select]").click();
            await page.locator("[data-chat-model-search]").waitFor();
            await page.keyboard.press("Escape");
          }
        },
        run: async (page) => {
          const trigger = page.locator(".chat-pane-cache__pane--active [data-chat-model-select]");
          if ((page.viewportSize()?.width ?? 1440) < 600) {
            await trigger.tap();
          } else {
            await trigger.click();
          }
          await page.waitForFunction(() => {
            const input = document.querySelector("[data-chat-model-search]");
            return (
              input &&
              input === document.activeElement &&
              document.querySelector("[data-chat-model-option]")
            );
          });
          return page.locator(".chat-controls__model-menu").evaluate((menu) => ({
            elements: menu.querySelectorAll("*").length,
            mountedRows: menu.querySelectorAll(".chat-controls__model-virtual-row").length,
            mountedOptions: menu.querySelectorAll("[data-chat-model-option]").length,
          }));
        },
      }),
    ),
    {
      ...chatSearch,
      id: "model-picker-search-paste",
      explicitOnly: true,
      expected: "One native edit filters the already-open picker without typing round trips.",
      run: async (page) => {
        await page.locator("[data-chat-model-search]").fill("Warm model 0999");
        await page.waitForFunction(() => {
          const rows = [
            ...document.querySelectorAll<HTMLElement>("[data-chat-model-option]"),
          ].filter((row) => row.checkVisibility());
          return rows.length === 1 && rows[0]?.dataset.chatModelOption === "example/model-999";
        });
        return { nativeEdits: 1 };
      },
    },
    ...(["open", "close"] as const).map((direction): EngineScenario =>
      Object.assign({}, sidebar, {
        id: `sidebar-${direction}`,
        explicitOnly: true,
        expected: `One native activation ${direction}s the populated drawer and preserves the conversation.`,
        prepare: async (page, gateway) => {
          await sidebar.prepare(page, gateway);
          if (direction === "open") {
            if (await page.locator(".shell--mobile-nav").count()) {
              await page.keyboard.press("Escape");
              await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
            } else {
              await page.locator(".sidebar-session-toolbar__collapse").first().click();
              await page.locator(".shell--nav-collapsed").waitFor();
            }
            await page
              .locator(".shell-nav")
              .evaluate((drawer) =>
                Promise.all(drawer.getAnimations().map((animation) => animation.finished)),
              );
          }
        },
        run: async (page) => {
          if (!(await page.locator(".shell--mobile-nav").count())) {
            if (direction === "open") {
              await navigation(page, "sessions");
              await page.locator(".shell--nav-collapsed").waitFor({ state: "detached" });
            } else {
              await page.locator(".sidebar-session-toolbar__collapse").first().click();
              await page.locator(".shell--nav-collapsed").waitFor();
            }
            await page
              .locator(".shell, .shell-nav")
              .evaluateAll((elements) =>
                Promise.all(
                  elements
                    .flatMap((element) => element.getAnimations())
                    .map((animation) => animation.finished),
                ),
              );
            if (direction === "close") {
              await page.locator(".sidebar-shell").evaluate((panel) => {
                if (
                  panel.checkVisibility({ visibilityProperty: true, checkOpacity: true }) ||
                  panel.contains(document.activeElement)
                ) {
                  throw new Error("Collapsed sidebar content must be hidden and release focus");
                }
              });
            } else {
              await page.locator(".sidebar-recent-session").first().waitFor({ state: "visible" });
            }
            return { nativeActivations: 1 };
          }
          if (direction === "open") {
            await openNavigationDrawer(page);
            if (!(await page.locator(".shell-nav :focus").first().isVisible())) {
              throw new Error("Opening the mobile drawer must focus a control inside it");
            }
          } else {
            await page.keyboard.press("Escape");
            await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
            await page
              .locator(".shell-nav")
              .evaluate((drawer) =>
                Promise.all(drawer.getAnimations().map((animation) => animation.finished)),
              );
            if ((await page.locator("#control-ui-main").getAttribute("inert")) !== null) {
              throw new Error("Closing the mobile drawer must restore the conversation");
            }
          }
          return { nativeActivations: 1 };
        },
      } satisfies Partial<EngineScenario>),
    ),
    {
      ...cronSearch,
      id: "cron-unbound-input-paste",
      explicitOnly: true,
      diagnostic: "Native input in the populated Cron document without its filtering handler.",
      expected: "The unbound input receives the query while retaining 500 jobs without a request.",
      prepare: async (page, gateway) => {
        await cronSearch.prepare(page, gateway);
        await page.getByRole("searchbox", { name: "Search automations" }).evaluate((input) => {
          if (
            !(input instanceof HTMLInputElement) ||
            input.value ||
            input === document.activeElement
          ) {
            throw new Error("Expected an empty, unfocused Cron search input");
          }
          const unbound = input.cloneNode(false);
          if (!(unbound instanceof HTMLInputElement)) {
            throw new Error("Expected a cloned search input");
          }
          unbound.value = input.value;
          input.replaceWith(unbound);
        });
      },
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("cron.list")).length;
        const search = page.getByRole("searchbox", { name: "Search automations" });
        const query = "Warm automation 0499";
        await search.fill(query);
        await frames(page);
        if (
          (await search.inputValue()) !== query ||
          (await cronLoadedJobCount(page)) !== 500 ||
          (await gateway.getRequests("cron.list")).length !== before
        ) {
          throw new Error("Unbound Cron input changed the retained rows or issued a request");
        }
        return { inputCharacters: query.length, retainedRows: 500, additionalRequests: 0 };
      },
    },
    ...repeated,
    {
      ...chatPicker,
      id: "model-picker-navigation-cycles",
      explicitOnly: true,
      expected:
        "Eighty keyboard moves advance the chat picker while retaining a visible active row.",
      prepare: async (page, gateway) => {
        await chatPicker.prepare(page, gateway);
        const trigger = page.locator(".chat-pane-cache__pane--active [data-chat-model-select]");
        if ((page.viewportSize()?.width ?? 1440) < 600) {
          await trigger.tap();
        } else {
          await trigger.click();
        }
        const search = page.locator("[data-chat-model-search]");
        await search.fill("Warm model");
        await frames(page);
      },
      run: async (page) => {
        const search = page.locator("[data-chat-model-search]");
        const initial = await search.getAttribute("aria-activedescendant");
        const value = initial
          ? await page.locator(`[id="${initial}"]`).getAttribute("data-chat-model-option")
          : null;
        const index = Number(value?.replace("example/model-", ""));
        for (let move = 0; move < 80; move++) {
          await search.press("ArrowDown");
        }
        await page.waitForFunction(
          (expected) => {
            const id = document
              .querySelector("[data-chat-model-search]")
              ?.getAttribute("aria-activedescendant");
            const row = id ? document.getElementById(id) : null;
            const viewport = row?.closest("[data-chat-model-window]");
            if (!row || !viewport || row.getAttribute("data-chat-model-option") !== expected) {
              return false;
            }
            const bounds = row.getBoundingClientRect();
            const clip = viewport.getBoundingClientRect();
            return bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1;
          },
          `example/model-${index + 80}`,
        );
        return { keyboardMoves: 80 };
      },
    },
    {
      ...sessions,
      id: "sessions-sort-cycles",
      explicitOnly: true,
      expected: "Sixteen Updated sorts reverse the visible session order each time.",
      run: async (page) => {
        const first = page.locator(".sessions-table tbody .session-data-row").first();
        for (let cycle = 0; cycle < 16; cycle++) {
          const previous = await first.textContent();
          await page
            .locator(".sessions-table")
            .getByRole("button", { name: "Updated", exact: true })
            .click();
          await page.waitForFunction((before) => {
            const row = document.querySelector(".sessions-table tbody .session-data-row");
            return row !== null && row.textContent !== before;
          }, previous);
        }
        return { sorts: 16 };
      },
    },
    {
      ...cron,
      id: "cron-held-typing-cycles",
      explicitOnly: true,
      expected: "Eight focus/edit cycles retain all 500 jobs behind one held request.",
      run: async (page, gateway) => {
        await cron.run(page, gateway);
        const search = page.getByRole("searchbox", { name: "Search automations" });
        const query = await search.inputValue();
        const heldRequests = (await gateway.getRequests("cron.list")).length;
        for (let cycle = 1; cycle < cycles; cycle++) {
          await search.blur();
          await frames(page);
          await search.click();
          await search.fill("");
          await search.pressSequentially(query);
          await frames(page);
          if (
            (await search.inputValue()) !== query ||
            (await cronLoadedJobCount(page)) !== 500 ||
            (await page.locator(".cron-table").getAttribute("aria-busy")) !== "true" ||
            (await gateway.getRequests("cron.list")).length !== heldRequests ||
            !(await search.evaluate((element) => element === document.activeElement))
          ) {
            throw new Error("Cron edit lost its draft, retained inventory, held request, or focus");
          }
        }
        return { cycles, retainedRows: 500, additionalRequests: 0 };
      },
    },
  ];
}
