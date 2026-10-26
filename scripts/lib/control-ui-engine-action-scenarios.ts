import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import { interactionScenarios } from "./control-ui-interaction-scenarios.ts";

/** Fixed work extends short actions beyond WebKit's coarse CPU sampling interval. */
export function createEngineActionScenarios(): readonly EngineScenario[] {
  const picker = interactionScenarios.find(({ id }) => id === "provider-model-picker-open-search");
  const cron = interactionScenarios.find(({ id }) => id === "cron-search-typing-pending");
  if (!picker || !cron) {
    throw new Error("Missing shared picker or held Cron scenario");
  }
  const cycles = 8;
  return [
    {
      ...picker,
      id: "provider-model-picker-cycles",
      explicitOnly: true,
      expected: "Eight complete picker search/dismiss cycles retain selection and return focus.",
      run: async (page, gateway) => {
        for (let cycle = 0; cycle < cycles; cycle++) {
          await picker.run(page, gateway);
        }
        return { cycles };
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
