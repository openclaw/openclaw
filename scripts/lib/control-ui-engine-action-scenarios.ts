import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames, openNavigationDrawer } from "./control-ui-interaction-navigation.ts";
import { cronLoadedJobCount, interactionScenarios } from "./control-ui-interaction-scenarios.ts";

/** Fixed work spans WebKit's coarse CPU samples; probes also count hot-path operations. */
export function createEngineActionScenarios(): readonly EngineScenario[] {
  const cron = interactionScenarios.find(({ id }) => id === "cron-search-typing-pending");
  const cronSearch = interactionScenarios.find(({ id }) => id === "cron-search");
  if (!cron || !cronSearch) {
    throw new Error("Missing shared Cron scenarios");
  }
  const cycles = 8;
  const chatPicker = interactionScenarios.find(({ id }) => id === "model-picker-first-open-search");
  const sessions = interactionScenarios.find(({ id }) => id === "sessions-sort");
  const sidebar = interactionScenarios.find(({ id }) => id === "sidebar-toggle");
  if (!chatPicker || !sessions || !sidebar) {
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
    ...(["open", "close"] as const).map((direction): EngineScenario =>
      Object.assign({}, sidebar, {
        id: `sidebar-${direction}`,
        explicitOnly: true,
        viewports: ["mobile"],
        expected: `One native activation ${direction}s the populated drawer and preserves the conversation.`,
        prepare: async (page, gateway) => {
          await sidebar.prepare(page, gateway);
          if (direction === "open") {
            await page.keyboard.press("Escape");
            await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
            await page
              .locator(".shell-nav")
              .evaluate((drawer) =>
                Promise.all(drawer.getAnimations().map((animation) => animation.finished)),
              );
          }
        },
        run: async (page) => {
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
