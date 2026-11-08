// Custom tool profiles: shipped-entry-point behavior for tools assembled from a
// config-defined profile, including built-in base inheritance and deny removal.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import * as openClawPluginTools from "./openclaw-plugin-tools.js";
import { resetActivePluginRegistryForTest } from "./test-helpers/temp-plugin-extension-fixtures.js";
import { createOpenClawOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";

const openClawOnlyPlan = createOpenClawOnlyToolConstructionPlan();
const pluginOnlyPlan = {
  ...openClawOnlyPlan,
  includeOpenClawTools: false,
  includePluginTools: true,
};

function expectToolNames(
  tools: readonly { name: string }[],
  present: string[],
  absent: string[] = [],
) {
  const names = tools.map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(present));
  for (const name of absent) {
    expect(names).not.toContain(name);
  }
}
function expectToolSurface(
  options: Parameters<typeof createOpenClawCodingTools>[0],
  present: string[],
  absent: string[] = [],
) {
  expectToolNames(createOpenClawCodingTools(options), present, absent);
}

describe("custom tool profiles through createOpenClawCodingTools", () => {
  afterEach(() => {
    resetActivePluginRegistryForTest();
  });

  it("gates the assembled tool surface through a custom profile", () => {
    const customConfig: OpenClawConfig = {
      tools: {
        profiles: { "desk-operator": { base: "coding", deny: ["automations", "cron"] } },
        profile: "desk-operator",
      },
    };
    expectToolSurface(
      { config: customConfig, toolConstructionPlan: openClawOnlyPlan },
      ["web_fetch"],
      ["automations"],
    );
    // The built-in base keeps its surface; only the custom deny entries remove tools.
    expectToolSurface(
      {
        config: { tools: { profile: "coding" } },
        toolConstructionPlan: openClawOnlyPlan,
      },
      ["web_fetch", "automations"],
      [],
    );
    // Custom denies still respect tools.alsoAllow regrants merged at the profile layer.
    expectToolSurface(
      {
        config: {
          tools: { profile: "desk-operator", alsoAllow: ["automations"] },
        },
        toolConstructionPlan: openClawOnlyPlan,
      },
      ["automations"],
      [],
    );
  });

  it("inherits manifest-contributed plugin grants through a custom profile base", () => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([
        {
          name: "profiled_plugin_tool",
          label: "Profiled plugin tool",
          description: "Profiled plugin tool test fixture",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({
            content: [{ type: "text" as const, text: "ok" }],
            details: {},
          }),
        },
      ]);
    const preparedModelRuntime = {
      metadataSnapshot: {
        plugins: [
          {
            id: "profiled-plugin",
            contracts: { tools: ["profiled_plugin_tool"] },
            toolMetadata: { profiled_plugin_tool: { profiles: ["coding"] } },
          },
        ],
      },
    } as never;
    const config: OpenClawConfig = {
      tools: {
        profiles: { "desk-operator": { base: "coding" } },
        profile: "desk-operator",
      },
    };

    try {
      const tools = createOpenClawCodingTools({
        config,
        includeCoreTools: false,
        preparedModelRuntime,
        toolConstructionPlan: pluginOnlyPlan,
      });

      expect(tools.map((tool) => tool.name)).toEqual(["profiled_plugin_tool"]);
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });
});
