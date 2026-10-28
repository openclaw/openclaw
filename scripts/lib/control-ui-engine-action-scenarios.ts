import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import { interactionScenarios } from "./control-ui-interaction-scenarios.ts";

/** Fixed work spans WebKit's coarse CPU samples; probes also count hot-path operations. */
export function createEngineActionScenarios(): readonly EngineScenario[] {
  const cron = interactionScenarios.find(({ id }) => id === "cron-search-typing-pending");
  if (!cron) {
    throw new Error("Missing shared held Cron scenario");
  }
  const cycles = 8;
  const chatPicker = interactionScenarios.find(({ id }) => id === "model-picker-first-open-search");
  const sessions = interactionScenarios.find(({ id }) => id === "sessions-sort");
  if (!chatPicker || !sessions) {
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
            (await page.locator(".cron-table__row").count()) !== 500 ||
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
