import { expect, it } from "vitest";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import type { ToolSearchCatalogEntry, ToolSearchCatalogRef } from "../../tool-search.js";
import {
  applyResolvedToolPromptFinalizer,
  createPromptBuildToolPolicy,
} from "./attempt-prompt-support.js";

const named = (...names: string[]) => names.map((name) => ({ name }));

function catalog(tools: { name: string }[]): ToolSearchCatalogRef {
  return {
    current: {
      entries: tools.map(
        (tool) =>
          ({
            id: tool.name,
            source: "openclaw",
            name: tool.name,
            description: "",
            tool,
          }) as ToolSearchCatalogEntry,
      ),
      counterScope: "permissions",
      searchCount: 0,
      describeCount: 0,
      callCount: 0,
    },
  };
}

function createPolicyFixture(
  activeToolNames: string[],
  tools = named(...activeToolNames),
  catalogRef?: ToolSearchCatalogRef,
  forceToolNames?: string[],
) {
  let names = [...activeToolNames];
  const session = {
    getActiveToolNames: () => [...names],
    getToolDefinition: (name: string) => createStubTool(name),
    setActiveToolsByName: (next: string[]) => void (names = [...next]),
  };
  const params = {
    session,
    effectiveTools: named(...names),
    uncompactedEffectiveTools: tools,
    tools,
    catalogRef,
    forceToolNames,
    codeModeControlsEnabled: false,
  };
  return { session, policy: createPromptBuildToolPolicy(params) };
}

function expectSurface(
  result: ReturnType<typeof createPromptBuildToolPolicy>["current"],
  names: string[],
  callableNames: string[],
) {
  expect(result).toMatchObject({
    activeToolNames: names,
    effectiveTools: named(...names),
    callableToolNames: callableNames,
    uncompactedEffectiveTools: named(...callableNames),
    tools: named(...callableNames),
  });
}

function finalize(activeToolNames: string[]) {
  return applyResolvedToolPromptFinalizer({
    prompt: "cron",
    activeToolNames,
    finalize: ({ prompt, messageToolAvailable }) => `${prompt}:${messageToolAvailable}`,
  });
}

it.each(["before", "after"] as const)(
  "keeps hook-denied tools fenced when the hook resolves %s a permission change",
  (hookTiming) => {
    const oldRead = { name: "read", generation: "old" };
    const tools = [oldRead];
    const catalogRef = catalog([oldRead]);
    const { session, policy } = createPolicyFixture(["tool_search"], tools, catalogRef);
    if (hookTiming === "before") {
      policy.apply(["read"]);
    }

    const freshRead = { name: "read", generation: "new" };
    const freshWrite = { name: "write", generation: "new" };
    const freshExec = { name: "exec", generation: "new" };
    tools.splice(0, tools.length, freshRead, freshWrite, freshExec);
    catalogRef.current!.entries = catalog(tools).current!.entries;
    session.setActiveToolsByName(["tool_search"]);
    policy.refresh();
    if (hookTiming === "after") {
      policy.apply(["read"]);
    }

    expect(policy.current.tools).toEqual([freshRead]);
    expect(catalogRef.current!.entries.map((entry) => entry.tool)).toEqual([freshRead]);
    expect(session.getActiveToolNames()).toEqual(["tool_search"]);

    // A subsequent hook revision may use the new full host baseline, never the old generation.
    policy.apply(["write"]);
    expect(catalogRef.current!.entries.map((entry) => entry.tool)).toEqual([freshWrite]);
  },
);

it.each([
  { active: ["tool_search", "message"], allow: [], force: [], expected: [] },
  { active: ["message", "read"], allow: [], force: ["message"], expected: ["message"] },
  { active: ["read"], allow: ["exec"], force: [], expected: [] },
])(
  "intersects hook $allow and host $active while retaining $force",
  ({ active, allow, force, expected }) => {
    const tools = named(...active);
    const catalogRef = catalog(tools);
    const { session, policy } = createPolicyFixture(active, tools, catalogRef, force);
    const result = policy.apply(allow);
    expectSurface(result, active, expected);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(expected);
    expect(session.getActiveToolNames()).toEqual(active);
    expect(finalize(result.callableToolNames)).toBe(
      `cron:${expected.some((name) => name === "message")}`,
    );
  },
);

it("keeps cataloged plugin tools allowed through the plugin group", () => {
  const pluginTool = createStubTool("plugin_lookup");
  setPluginToolMeta(pluginTool, { pluginId: "example", optional: false });
  const catalogRef = catalog([pluginTool]);
  const result = createPolicyFixture(["tool_search"], [pluginTool], catalogRef).policy.apply([
    "group:plugins",
  ]);

  expect(result.activeToolNames).toEqual(["tool_search"]);
  expect(result.effectiveTools).toEqual([{ name: "tool_search" }]);
  expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["plugin_lookup"]);
});
