import { expect, it, onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ToolsSchema } from "../config/zod-schema.agent-runtime.js";
import { AgentsSchema } from "../config/zod-schema.agents.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";
import { buildCodeModeCatalogPrompt } from "./code-mode.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import type { ToolUsageRankingSnapshot } from "./tool-usage-ranking.js";

function createCatalog(size = 100) {
  const catalogRef = createToolSearchCatalogRef();
  const tools = [
    ...Array.from({ length: size }, (_, i) =>
      createStubTool(`alpha_${String(i).padStart(3, "0")}_${"x".repeat(100)}`),
    ),
    createStubTool("memory_search"),
    createStubTool("read"),
  ];
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  onTestFinished(() => clearToolSearchCatalog({ catalogRef }));
  const render = (
    ctx: Pick<ToolSearchToolContext, "config" | "runtimeConfig" | "agentId"> = {},
    ranking?: ToolUsageRankingSnapshot,
  ) => {
    const prompt = buildCodeModeCatalogPrompt(
      { ...ctx, catalogRef },
      catalogRef.current!.entries,
      ranking,
    );
    const start = prompt.indexOf("Enabled async tool globals");
    expect(start).toBeGreaterThanOrEqual(0);
    return prompt.slice(start);
  };
  return { tools, render };
}

function budgetConfig(catalogIndexMaxChars?: number): OpenClawConfig {
  return {
    tools: { codeMode: { enabled: true, catalogIndexMaxChars } },
  };
}

it("uses the configured budget without sharing prompt bytes across different budgets", () => {
  const { tools, render } = createCatalog();
  const baseline = render();
  expect(baseline).toContain("additional tools omitted");
  expect(baseline).not.toContain(`- ${tools[99]!.name} `);
  expect(baseline.length).toBeLessThanOrEqual(8_000);
  expect(render({ config: budgetConfig(8_000) })).toBe(baseline);

  const expanded = render({ config: budgetConfig(32_000) });
  expect(expanded).toContain("- memory_search ");
  expect(expanded).not.toContain("additional tools omitted");
  expect(expanded.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(tools.length);
  expect(expanded.length).toBeGreaterThan(8_000);
  expect(expanded.length).toBeLessThanOrEqual(32_000);
  expect(render()).toBe(baseline);
});

it("keeps core and ranked signatures within the configured budget when ranking is active", () => {
  const { tools, render } = createCatalog(400);
  const hot = tools[399]!.name;
  const ranking: ToolUsageRankingSnapshot = {
    version: 1,
    at: 0,
    orderedToolIds: [`openclaw:core:${hot}`],
  };
  const sizes = [4_000, 16_000].map((budget) => {
    const index = render({ config: budgetConfig(budget) }, ranking);
    expect(index).toContain(`- ${hot} `);
    expect(index).toContain("- read ");
    expect(index).toContain("additional tools omitted");
    expect(index.length).toBeLessThanOrEqual(budget);
    return index.length;
  });
  expect(sizes[1]).toBeGreaterThan(sizes[0]!);
});

it("inherits global budgets and honors agent and runtime config overrides on a shared catalog", () => {
  const { render } = createCatalog();
  const config: OpenClawConfig = {
    ...budgetConfig(32_000),
    agents: {
      entries: {
        inherited: { tools: { codeMode: true } },
        compact: { tools: { codeMode: { catalogIndexMaxChars: 4_000 } } },
      },
    },
  };
  const inherited = render({ config, agentId: "inherited" });
  expect(inherited).not.toContain("additional tools omitted");
  const compact = render({ config, agentId: "compact" });
  expect(compact).toContain("additional tools omitted");
  expect(compact.length).toBeLessThanOrEqual(4_000);
  expect(render({ config, runtimeConfig: budgetConfig(4_000) })).toBe(compact);
  expect(render({ config, agentId: "inherited" })).toBe(inherited);
});

it.each([undefined, 1, 1_000, 32_000, 128_000, 128_001])(
  "accepts authored catalog budget %s at global and agent scopes",
  (catalogIndexMaxChars) => {
    const codeMode = {
      enabled: true,
      ...(catalogIndexMaxChars === undefined ? {} : { catalogIndexMaxChars }),
    };
    expect(ToolsSchema.parse({ codeMode })?.codeMode).toEqual(codeMode);
    expect(
      AgentsSchema.parse({ entries: { fixture: { tools: { codeMode } } } })?.entries?.fixture?.tools
        ?.codeMode,
    ).toEqual(codeMode);
  },
);

it.each([0, -1, 1.5, "32000", null, Infinity, Number.NaN])(
  "rejects invalid authored catalog budget %s",
  (catalogIndexMaxChars) => {
    expect(ToolsSchema.safeParse({ codeMode: { catalogIndexMaxChars } }).success).toBe(false);
    expect(
      AgentsSchema.safeParse({
        entries: { fixture: { tools: { codeMode: { catalogIndexMaxChars } } } },
      }).success,
    ).toBe(false);
  },
);

it.each([
  [1, 1_000],
  [32_000, 32_000],
  [1_000_000, 128_000],
])("clamps valid authored budget %i to %i characters", (authored, effective) => {
  expect(resolveCodeModeConfig(budgetConfig(authored)).catalogIndexMaxChars).toBe(effective);
});

it.each([false, true])("renders both clamp endpoints (usage ranking: %s)", (ranked) => {
  const { tools, render } = createCatalog(1_200);
  const hot = tools[1_199]!.name;
  const ranking: ToolUsageRankingSnapshot | undefined = ranked
    ? { version: 1, at: 0, orderedToolIds: [`openclaw:core:${hot}`] }
    : undefined;
  for (const { authored, effective } of [
    { authored: 1, effective: 1_000 },
    { authored: 1_000_000, effective: 128_000 },
  ]) {
    const index = render({ config: budgetConfig(authored) }, ranking);
    expect(index).toBe(render({ config: budgetConfig(effective) }, ranking));
    expect(index.length).toBeGreaterThan(effective - 500);
    expect(index.length).toBeLessThanOrEqual(effective);
    expect(index).toContain("- read ");
    expect(index).toContain("additional tools omitted");
    if (ranked) {
      expect(index).toContain(`- ${hot} `);
    }
  }
});
