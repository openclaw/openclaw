import type { SelectPicker } from "../../ui/src/components/select-picker.ts";
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
  const picker = interactionScenarios.find(({ id }) => id === "provider-model-picker-open");
  if (!picker) {
    throw new Error("Missing shared provider picker scenario");
  }
  const pickerNavigation: EngineScenario = {
    ...picker,
    id: "provider-model-picker-navigate",
    explicitOnly: true,
    expected: "Twenty keyboard moves retain a visible active model choice.",
    prepare: async (page, gateway) => {
      await picker.prepare(page, gateway);
      await picker.run(page, gateway);
    },
    run: async (page) => {
      const search = page
        .locator(".model-providers__defaults openclaw-select-picker")
        .first()
        .locator(".picker-select__search");
      const before = await search.getAttribute("aria-activedescendant");
      const initialValue = before
        ? await page.locator(`[id="${before}"]`).getAttribute("data-value")
        : null;
      const initialIndex = initialValue ? Number(initialValue.replace("example/model-", "")) : -1;
      for (let move = 0; move < 20; move++) {
        await search.press("ArrowDown");
      }
      await frames(page);
      const active = await search.getAttribute("aria-activedescendant");
      if (!active || active === before) {
        throw new Error("Picker keyboard navigation did not advance its active choice");
      }
      await page.waitForFunction(
        ({ id, value }) => {
          const choice = document.getElementById(id);
          const viewport = choice?.closest(".picker-select__options");
          if (!choice || !viewport || choice.getAttribute("data-value") !== value) {
            return false;
          }
          const bounds = choice.getBoundingClientRect();
          const clip = viewport.getBoundingClientRect();
          return bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1;
        },
        { id: active, value: `example/model-${initialIndex + 20}` },
      );
      return { keyboardMoves: 20 };
    },
  };
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
    pickerNavigation,
    {
      ...pickerNavigation,
      id: "provider-model-picker-navigation-work",
      explicitOnly: true,
      diagnostic: "Model value getter counters measure catalog work, not uninstrumented latency.",
      expected:
        "Twenty keyboard moves retain a visible active choice without rescanning model keys.",
      run: async (page, gateway) => {
        const selector = ".model-providers__defaults openclaw-select-picker";
        await page.evaluate((pickerSelector) => {
          const host = document.querySelector<SelectPicker>(pickerSelector)!;
          const count = { reads: 0 };
          // SAFETY: This fresh benchmark document owns the counter and instrumented catalog.
          Reflect.set(window, "__enginePickerKeyReads", count);
          for (const option of host.params.options) {
            const value = option.value;
            Object.defineProperty(option, "value", {
              configurable: true,
              get() {
                count.reads += 1;
                return value;
              },
            });
          }
        }, selector);
        await pickerNavigation.run(page, gateway);
        const catalogKeyReads = await page.evaluate(() => {
          // SAFETY: The counter is installed above in this benchmark document.
          return (Reflect.get(window, "__enginePickerKeyReads") as { reads: number }).reads;
        });
        return { keyboardMoves: 20, catalogKeyReads };
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
