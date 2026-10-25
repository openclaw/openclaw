import { beforeEach, expect, it, vi } from "vitest";
import { logDecisionToolPrefilter } from "../../../decisions/diagnostics.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import type { ToolSearchCatalogEntry, ToolSearchCatalogRef } from "../../tool-search.js";
import {
  applyResolvedToolPromptFinalizer,
  createPromptBuildToolPolicy,
} from "./attempt-prompt-support.js";

// mock-isolation: Observe policy facts without creating the process-global logger or warning budget.
vi.mock("../../../decisions/diagnostics.js", () => ({
  logDecisionToolPrefilter: vi.fn(),
}));

beforeEach(() => void vi.mocked(logDecisionToolPrefilter).mockClear());

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
) {
  let names = [...activeToolNames];
  const session = {
    getActiveToolNames: () => [...names],
    getToolDefinition: (name: string) => createStubTool(name),
    setActiveToolsByName: vi.fn((next: string[]) => void (names = [...next])),
  };
  const params = {
    session,
    effectiveTools: named(...names),
    uncompactedEffectiveTools: tools,
    tools,
    catalogRef,
    codeModeControlsEnabled: false,
  };
  return {
    params,
    apply: (toolsAllow: string[] = [], forceToolNames?: string[]) =>
      createPromptBuildToolPolicy({ ...params, forceToolNames }).apply(toolsAllow),
  };
}

function expectSurface(
  result: ReturnType<typeof createPromptBuildToolPolicy>["current"],
  names: string[],
) {
  const tools = named(...names);
  expect(result).toMatchObject({
    activeToolNames: names,
    effectiveTools: tools,
    uncompactedEffectiveTools: tools,
    tools,
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
    const fixture = createPolicyFixture(["tool_search"], tools, catalogRef);
    const policy = createPromptBuildToolPolicy(fixture.params);
    if (hookTiming === "before") {
      policy.apply(["read"]);
    }

    const freshRead = { name: "read", generation: "new" };
    const freshWrite = { name: "write", generation: "new" };
    const freshExec = { name: "exec", generation: "new" };
    tools.splice(0, tools.length, freshRead, freshWrite, freshExec);
    catalogRef.current!.entries = catalog(tools).current!.entries;
    fixture.params.session.setActiveToolsByName(["tool_search"]);
    policy.refresh();
    if (hookTiming === "after") {
      policy.apply(["read"]);
    }

    expect(policy.current.tools).toEqual([freshRead]);
    expect(catalogRef.current!.entries.map((entry) => entry.tool)).toEqual([freshRead]);
    expect(fixture.params.session.getActiveToolNames()).toEqual(["tool_search"]);

    // A subsequent hook revision may use the new full host baseline, never the old generation.
    policy.apply(["write"]);
    expect(catalogRef.current!.entries.map((entry) => entry.tool)).toEqual([freshWrite]);
    expect(logDecisionToolPrefilter).not.toHaveBeenCalled();
  },
);

it("removes every submitted tool and catalog entry for an empty hook allowlist", () => {
  const catalogRef = catalog(named("read", "write"));
  const fixture = createPolicyFixture(
    ["tool_search", "message"],
    named("read", "write", "message"),
    catalogRef,
  );
  const result = fixture.apply();

  expectSurface(result, []);
  expect(catalogRef.current?.entries).toEqual([]);
  expect(fixture.params.session.getActiveToolNames()).toEqual([]);
  expect(finalize(result.activeToolNames)).toBe("cron:false");
});

it("keeps host-required tools when a hook denies optional tools", () => {
  const fixture = createPolicyFixture(["message", "read"]);
  const result = fixture.apply([], ["message"]);

  expectSurface(result, ["message"]);
  expect(finalize(result.activeToolNames)).toBe("cron:true");
});

it("cannot add a tool that the host-resolved surface already removed", () => {
  expectSurface(createPolicyFixture(["read"]).apply(["exec"]), []);
});

it("keeps cataloged plugin tools allowed through the plugin group", () => {
  const pluginTool = createStubTool("plugin_lookup");
  setPluginToolMeta(pluginTool, { pluginId: "example", optional: false });
  const catalogRef = catalog([pluginTool]);
  const result = createPolicyFixture(["tool_search"], [pluginTool], catalogRef).apply([
    "group:plugins",
  ]);

  expect(result.activeToolNames).toEqual(["tool_search"]);
  expect(result.effectiveTools).toEqual([{ name: "tool_search" }]);
  expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["plugin_lookup"]);
});
