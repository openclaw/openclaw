import type { Page } from "playwright";
import type { ToolsCatalogResult, ToolsEffectiveResult } from "../../ui/src/api/types.ts";
import { pathForAgentPanel, pathForRoute } from "../../ui/src/app-route-paths.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../ui/src/lib/plugins/index.ts";
import { createSkill } from "../../ui/src/pages/skills/view.test-support.ts";
import { defaultControlUiFeatureMethods } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import type {
  InteractionFixtureOverrides,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const inventorySize = 1_000;
const agentCount = 300;
const toolGroupCount = 40;
const toolsPerGroup = 25;
const catalogPageSize = 100;
const pluginQuery = "Data plugin 09";
const skillQuery = "Data skill 0999";

function suffix(index: number) {
  return String(index).padStart(4, "0");
}

export function createDataCatalogFixture(revision = 1): InteractionFixtureOverrides {
  const plugins: PluginCatalogItem[] = Array.from({ length: inventorySize }, (_, index) => ({
    id: `data-plugin-${suffix(index)}`,
    catalogId: `data-catalog-${suffix(index)}`,
    name: `Data plugin ${suffix(index)}${index === 0 && revision > 1 ? " updated" : ""}`,
    packageName: `@synthetic/data-plugin-${suffix(index)}`,
    description: `Synthetic catalog integration ${index} for data-heavy page profiling.`,
    origin: "global",
    kind: ["tool"],
    installed: true,
    enabled: true,
    state: "enabled",
    removable: true,
  }));
  const entries: PluginDiscoveryEntry[] = plugins.map((plugin, index) => ({
    id: `data-catalog-${suffix(index)}`,
    catalog: {
      name: plugin.name,
      summary: plugin.description,
      author: "synthetic-publisher",
      official: index % 3 === 0,
      categories: ["tools"],
      downloads: inventorySize - index,
      latestVersion: "1.0.0",
    },
    local: {
      pluginId: plugin.id,
      present: true,
      installed: true,
      enabled: true,
      state: "enabled",
      action: "manage",
    },
  }));
  const catalogPage = (offset: number): PluginDiscoveryResult => ({
    items: entries.slice(offset, offset + catalogPageSize),
    ...(offset + catalogPageSize < inventorySize
      ? { nextCursor: `catalog:${offset + catalogPageSize}` }
      : {}),
  });
  const groups: ToolsCatalogResult["groups"] = Array.from(
    { length: toolGroupCount },
    (_, groupIndex) => ({
      id: `plugin:data-tools-${groupIndex}`,
      label: `Data tools ${suffix(groupIndex)}`,
      source: "plugin",
      pluginId: `data-tools-${groupIndex}`,
      tools: Array.from({ length: toolsPerGroup }, (_tool, itemIndex) => {
        const index = groupIndex * toolsPerGroup + itemIndex;
        return {
          id: `data_tool_${suffix(index)}`,
          label: `data_tool_${suffix(index)}`,
          description: `Synthetic tool ${index} with policy and session diagnostics.`,
          source: "plugin",
          pluginId: `data-tools-${groupIndex}`,
          defaultProfiles: ["full"],
        };
      }),
    }),
  );
  const tools = groups.flatMap((group) => group.tools);
  const effective: ToolsEffectiveResult = {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "plugin",
        label: "Plugin tools",
        source: "plugin",
        tools: tools.map((tool) => ({ ...tool, rawDescription: tool.description })),
      },
    ],
    toolAccess: {
      checked: "live-session",
      profiles: [{ profile: "full", source: "tools.profile", active: true }],
      tools: tools.map((tool) => ({
        id: tool.id,
        status: "available",
        reasons: [
          { kind: "profile", label: "Included by the full profile", source: "tools.profile" },
          { kind: "runtime", label: "Included in the current session" },
        ],
      })),
    },
  };
  const config = {
    tools: { profile: "full" },
    agents: { entries: { main: {} } },
  };
  const featureMethods = [
    ...defaultControlUiFeatureMethods,
    "plugins.list",
    "plugins.catalog.browse",
    "plugins.catalog.categories",
    "plugins.catalog.get",
    "plugins.uiDescriptors",
    "tools.catalog",
    "tools.effective",
    "skills.status",
    "agents.list",
  ];
  return {
    featureMethods,
    featureEvents: ["plugins.changed"],
    methodResponses: {
      "config.get": {
        config,
        sourceConfig: config,
        hash: "data-catalog-config",
        raw: JSON.stringify(config),
        valid: true,
        issues: [],
      },
      "agents.list": {
        agents: Array.from({ length: agentCount }, (_, index) => ({
          id: index === 0 ? "main" : `data-agent-${suffix(index)}`,
          name: index === 0 ? "Main" : `Data agent ${suffix(index)}`,
        })),
        defaultId: "main",
        mainKey: "main",
      },
      "plugins.list": { plugins, diagnostics: [], mutationAllowed: true, generation: revision },
      "plugins.uiDescriptors": {
        ok: true,
        generation: revision,
        descriptors: [],
        methods: featureMethods,
        controlUiTabs: [],
        controlUiWidgetKinds: [],
        controlUiLinkReaders: [],
        pluginSurfaceUrls: {},
      },
      "plugins.catalog.categories": {
        categories: [{ slug: "tools", label: "Tools", description: "Synthetic tools", order: 0 }],
      },
      "plugins.catalog.browse": {
        cases: [
          {
            match: { query: pluginQuery },
            response: {
              items: entries.filter((entry) => entry.catalog.name.includes(pluginQuery)),
            },
          },
          ...Array.from({ length: inventorySize / catalogPageSize - 1 }, (_, index) => {
            const offset = (index + 1) * catalogPageSize;
            return { match: { cursor: `catalog:${offset}` }, response: catalogPage(offset) };
          }),
          { response: catalogPage(0) },
        ],
      },
      "tools.catalog": { agentId: "main", profiles: [{ id: "full", label: "Full" }], groups },
      "tools.effective": effective,
      "skills.status": {
        workspaceDir: "/synthetic/workspace",
        managedSkillsDir: "/synthetic/skills",
        skills: Array.from({ length: inventorySize }, (_, index) =>
          createSkill({
            name: `Data skill ${suffix(index)}`,
            skillKey: `data-skill-${suffix(index)}`,
            source: index % 4 === 0 ? "openclaw-bundled" : "openclaw-managed",
            bundled: index % 4 === 0,
            primaryEnv: undefined,
            description: `Synthetic skill ${index} with availability diagnostics.`,
            missing: { bins: ["synthetic-tool"], anyBins: [], env: [], config: [], os: [] },
            eligible: false,
          }),
        ),
      },
    },
  };
}

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function countRows(page: Page, selector: string, expected: number) {
  await page.waitForFunction(
    ({ selector: rowSelector, expected: expectedCount }) =>
      document.querySelectorAll(rowSelector).length === expectedCount,
    { selector, expected },
  );
}

const fixture = {
  fixtureOverrides: () => createDataCatalogFixture(),
  dataPage: "catalog" as const,
};

function agentSelectionScenario(roundTripMs: 0 | 100): InteractionScenario {
  return {
    ...fixture,
    id: roundTripMs ? "data-agent-selection-100ms" : "data-agent-selection",
    route: pathForAgentPanel("main", "overview"),
    expected: "The hydrated 300-agent selector reopens and selects the final agent.",
    rowSelector: "[data-agent-option]",
    createRequestHandlers: () => ({
      "agent.identity.get": async (params) => {
        // Simulate only this RPC's 100 ms round trip, not asset or Internet latency.
        if (roundTripMs) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, roundTripMs);
          });
        }
        const { agentId } = params as { agentId: string };
        return {
          agentId,
          name: agentId === "main" ? "OpenClaw" : `Data agent ${agentId.slice(-4)}`,
          avatar: "",
          avatarStatus: "none",
          emoji: "🧪",
        };
      },
    }),
    prepare: async (page) => {
      const trigger = page.locator(".settings-sidebar__agent .agent-select__trigger");
      await trigger.click();
      await countRows(page, "[data-agent-option]", agentCount);
      // Each rendered emoji acknowledges that agent's initial identity reply.
      await countRows(
        page,
        '[data-agent-option] .identity-avatar__text[data-avatar="🧪"]',
        agentCount,
      );
      await page.keyboard.press("Escape");
      await page.locator(".agent-select__menu").waitFor({ state: "hidden" });
      await frames(page);
    },
    run: async (page) => {
      const trigger = page.locator(".settings-sidebar__agent .agent-select__trigger");
      await trigger.click();
      await countRows(page, "[data-agent-option]", agentCount);
      await page.locator('[data-agent-option][value="data-agent-0299"]').click();
      await page.waitForFunction(() =>
        document
          .querySelector(".settings-sidebar__agent .agent-select__trigger")
          ?.textContent?.includes("Data agent 0299"),
      );
      await trigger.locator('.identity-avatar__text[data-avatar="🧪"]').waitFor();
      await frames(page);
      return {
        fixtureAgents: agentCount,
        selectedFinalAgent: true,
        identityRoundTripMs: roundTripMs,
      };
    },
  };
}

export const dataCatalogScenarios: readonly InteractionScenario[] = [
  {
    ...fixture,
    id: "data-plugins-render",
    route: pathForRoute("plugins"),
    expected: "Opening installed settings renders all 1,000 plugins.",
    rowSelector: ".plugins-settings-row",
    prepare: async (page) => {
      await page.getByRole("button", { name: "Plugin settings", exact: true }).waitFor();
    },
    run: async (page) => {
      await page.getByRole("button", { name: "Plugin settings", exact: true }).click();
      await countRows(page, ".plugins-settings-row", inventorySize);
      await frames(page);
      return { fixturePlugins: inventorySize, mountedPlugins: inventorySize };
    },
  },
  {
    ...fixture,
    id: "data-plugins-filter",
    route: pathForRoute("plugin-settings"),
    expected: "Typing filters the 1,000 installed plugins to 100 matching entries.",
    rowSelector: ".plugins-settings-row",
    prepare: async (page) => countRows(page, ".plugins-settings-row", inventorySize),
    run: async (page) => {
      await page
        .getByRole("searchbox", { name: "Search installed plugins" })
        .pressSequentially(pluginQuery);
      await countRows(page, ".plugins-settings-row", 100);
      await frames(page);
      return { fixturePlugins: inventorySize, matchingPlugins: 100 };
    },
  },
  {
    ...fixture,
    id: "data-plugins-refresh",
    route: pathForRoute("plugin-settings"),
    expected:
      "A plugin publication refreshes 1,000 installed entries and displays its changed name.",
    rowSelector: ".plugins-settings-row",
    prepare: async (page, gateway) => {
      await countRows(page, ".plugins-settings-row", inventorySize);
      const updated = createDataCatalogFixture(2).methodResponses;
      if (!updated) {
        throw new Error("Updated catalog fixture is missing its responses");
      }
      await gateway.setMethodResponse("plugins.list", updated["plugins.list"]);
      await gateway.setMethodResponse("plugins.uiDescriptors", updated["plugins.uiDescriptors"]);
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("plugins.list")).length;
      await gateway.emitGatewayEvent("plugins.changed", { generation: 2 });
      await gateway.waitForRequest("plugins.list", { after });
      await page
        .locator('[data-plugin-id="data-plugin-0000"] .settings-row__title')
        .getByText("Data plugin 0000 updated", { exact: true })
        .waitFor();
      await countRows(page, ".plugins-settings-row", inventorySize);
      await frames(page);
      return { fixturePlugins: inventorySize, mountedPlugins: inventorySize };
    },
  },
  {
    ...fixture,
    id: "data-plugins-scroll",
    route: pathForRoute("plugin-settings"),
    expected: "The final installed plugin remains reachable in the 1,000-entry list.",
    prepare: async (page) => countRows(page, ".plugins-settings-row", inventorySize),
    run: async (page) => {
      const last = page.locator('[data-plugin-id="data-plugin-0999"]');
      await last.scrollIntoViewIfNeeded();
      if (!(await last.isVisible())) {
        throw new Error("The final plugin is not visible after scrolling");
      }
      await frames(page);
    },
  },
  {
    ...fixture,
    id: "data-catalog-load-more",
    route: pathForRoute("plugins"),
    expected: "The final cursor page appends 100 cards to a 900-card catalog.",
    rowSelector: ".plugin-catalog-card",
    prepare: async (page) => {
      await page.getByRole("button", { name: "Tools", exact: true }).click();
      await countRows(page, ".plugin-catalog-card", catalogPageSize);
      for (let count = catalogPageSize; count < 900; count += catalogPageSize) {
        await page.getByRole("button", { name: "Load more", exact: true }).click();
        await countRows(page, ".plugin-catalog-card", count + catalogPageSize);
      }
    },
    run: async (page) => {
      await page.getByRole("button", { name: "Load more", exact: true }).click();
      await countRows(page, ".plugin-catalog-card", inventorySize);
      await frames(page);
      return { fixturePlugins: inventorySize, mountedPlugins: inventorySize };
    },
  },
  {
    ...fixture,
    id: "data-catalog-search",
    route: pathForRoute("plugins"),
    expected: "Catalog search waits for its debounced Gateway request and renders 100 results.",
    rowSelector: ".plugin-catalog-card",
    prepare: async (page) => {
      await page.getByRole("searchbox", { name: "Search plugins" }).waitFor();
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("plugins.catalog.browse", { query: pluginQuery }))
        .length;
      await page.getByRole("searchbox", { name: "Search plugins" }).fill(pluginQuery);
      await gateway.waitForRequest("plugins.catalog.browse", {
        after,
        match: { query: pluginQuery },
      });
      await countRows(page, ".plugin-catalog-card", 100);
      await frames(page);
      return { fixturePlugins: inventorySize, matchingPlugins: 100 };
    },
  },
  agentSelectionScenario(0),
  agentSelectionScenario(100),
  {
    ...fixture,
    id: "data-agent-skills-render",
    route: pathForAgentPanel("main", "overview"),
    expected: "The skills tab displays a 1,000-skill report for a 300-agent roster.",
    rowSelector: ".agent-skill-row",
    prepare: async (page) => {
      await page.getByRole("tab", { name: /^Skills/ }).waitFor();
    },
    run: async (page) => {
      await page.getByRole("tab", { name: /^Skills/ }).click();
      await countRows(page, ".agent-skill-row", inventorySize);
      await frames(page);
      return { fixtureAgents: agentCount, fixtureSkills: inventorySize };
    },
  },
  {
    ...fixture,
    id: "data-agent-skills-filter",
    route: pathForAgentPanel("main", "skills"),
    expected: "Filtering 1,000 skills retains only Data skill 0999.",
    rowSelector: ".agent-skill-row",
    prepare: async (page) => countRows(page, ".agent-skill-row", inventorySize),
    run: async (page) => {
      await page.locator('input[name="agent-skills-filter"]').pressSequentially(skillQuery);
      await countRows(page, ".agent-skill-row", 1);
      await page
        .locator(".agent-skill-row .settings-row__title")
        .getByText(skillQuery, { exact: true })
        .waitFor();
      await frames(page);
      return { fixtureSkills: inventorySize, matchingSkills: 1 };
    },
  },
  {
    ...fixture,
    id: "data-agent-skills-refresh",
    route: pathForAgentPanel("main", "skills"),
    expected: "Refreshing the 1,000-skill report preserves its rows and diagnostics.",
    rowSelector: ".agent-skill-row, .agent-skill-row .settings-row__desc",
    prepare: async (page) => countRows(page, ".agent-skill-row", inventorySize),
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("skills.status")).length;
      const section = page.locator(".settings-section").filter({
        has: page.locator('input[name="agent-skills-filter"]'),
      });
      await section.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("skills.status", { after });
      await countRows(page, ".agent-skill-row", inventorySize);
      await frames(page);
    },
  },
  {
    ...fixture,
    id: "data-agent-skills-scroll",
    route: pathForAgentPanel("main", "skills"),
    expected: "The last installed skill remains reachable in the 1,000-skill report.",
    prepare: async (page) => countRows(page, ".agent-skill-row", inventorySize),
    run: async (page) => {
      const last = page.locator(".agent-skill-row").filter({ hasText: "Data skill 0999" });
      await last.scrollIntoViewIfNeeded();
      if (!(await last.isVisible())) {
        throw new Error("The final installed skill is not visible after scrolling");
      }
      await frames(page);
    },
  },
  {
    ...fixture,
    id: "data-agent-tools-render",
    route: pathForAgentPanel("main", "overview"),
    expected: "The tools tab displays 40 groups and 1,000 tool summaries with diagnostics.",
    rowSelector: ".agent-tool-card, .agent-tool-details",
    prepare: async (page) => {
      await page.getByRole("tab", { name: /^Tools/ }).waitFor();
    },
    run: async (page) => {
      await page.getByRole("tab", { name: /^Tools/ }).click();
      await countRows(page, ".agent-tools-group", toolGroupCount);
      await countRows(page, ".agent-tool-card", toolGroupCount * toolsPerGroup);
      await frames(page);
      return {
        fixtureAgents: agentCount,
        fixtureTools: toolGroupCount * toolsPerGroup,
        mountedDetailPanels: await page.locator(".agent-tool-details").count(),
      };
    },
  },
  {
    ...fixture,
    id: "data-agent-tool-disclosure",
    route: pathForAgentPanel("main", "tools"),
    expected: "Opening a tool displays its current session diagnostics and policy sources.",
    rowSelector: ".agent-tool-details",
    prepare: async (page) => {
      await countRows(page, ".agent-tool-card", toolGroupCount * toolsPerGroup);
      await page.locator(".agent-tools-group > summary").first().click();
    },
    run: async (page) => {
      const tool = page.locator(".agent-tool-card").first();
      await tool.locator(":scope > summary").click();
      await tool.locator(".agent-tool-policy").getByText("Included by the full profile").waitFor();
      await frames(page);
      return {
        fixtureTools: toolGroupCount * toolsPerGroup,
        mountedDetailPanels: await page.locator(".agent-tool-details").count(),
      };
    },
  },
];
