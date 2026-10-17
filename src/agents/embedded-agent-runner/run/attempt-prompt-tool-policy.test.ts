import { beforeEach, describe, expect, it, vi } from "vitest";
import { logDecisionToolPrefilter } from "../../../decisions/diagnostics.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import type { ToolSearchCatalogEntry, ToolSearchCatalogRef } from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  applyPromptBuildToolsAllow,
  applyResolvedToolPromptFinalizer,
  createPromptBuildToolPolicy,
} from "./attempt-prompt-support.js";

// mock-isolation: Observe policy facts without creating the process-global logger or warning budget.
vi.mock("../../../decisions/diagnostics.js", () => ({
  logDecisionToolPrefilter: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(logDecisionToolPrefilter).mockClear();
});

function catalogEntry(
  name: string,
  tool: { name: string; description?: string } = { name, description: name },
): ToolSearchCatalogEntry {
  return {
    id: name,
    source: "openclaw",
    name,
    description: tool.description ?? "",
    tool,
  } as ToolSearchCatalogEntry;
}

function createSession(activeToolNames: string[]) {
  let names = [...activeToolNames];
  return {
    session: {
      getActiveToolNames: () => [...names],
      setActiveToolsByName: vi.fn((next: string[]) => {
        names = [...next];
      }),
    },
    readNames: () => names,
  };
}

function catalog(entries: ToolSearchCatalogEntry[]): ToolSearchCatalogRef {
  return {
    current: {
      entries,
      counterScope: "permissions",
      searchCount: 0,
      describeCount: 0,
      callCount: 0,
    },
  };
}

function applyAllow(
  fixture: ReturnType<typeof createSession>,
  tools: { name: string }[],
  overrides: Partial<Parameters<typeof applyPromptBuildToolsAllow>[0]> = {},
) {
  return applyPromptBuildToolsAllow({
    session: fixture.session,
    toolsAllow: [],
    baseline: {
      activeToolNames: fixture.readNames(),
      catalogEntries: [...(overrides.catalogRef?.current?.entries ?? [])],
    },
    effectiveTools: tools,
    uncompactedEffectiveTools: tools,
    tools,
    codeModeControlsEnabled: false,
    ...overrides,
  });
}

function expectSurface(result: ReturnType<typeof applyAllow>, names: string[]) {
  const { activeToolNames, effectiveTools, uncompactedEffectiveTools, tools } = result;
  expect({ activeToolNames, effectiveTools, uncompactedEffectiveTools, tools }).toEqual({
    activeToolNames: names,
    effectiveTools: names.map((name) => ({ name })),
    uncompactedEffectiveTools: names.map((name) => ({ name })),
    tools: names.map((name) => ({ name })),
  });
}

function finalize(activeToolNames: string[]) {
  return applyResolvedToolPromptFinalizer({
    prompt: "cron",
    activeToolNames,
    finalize: ({ prompt, messageToolAvailable }) => `${prompt}:${messageToolAvailable}`,
  });
}

describe("applyPromptBuildToolsAllow", () => {
  it.each(["before", "after"] as const)(
    "keeps hook-denied tools fenced when the hook resolves %s a permission change",
    (hookTiming) => {
      const fixture = createSession(["tool_search"]);
      const oldRead = { name: "read", generation: "old" };
      const tools = [oldRead];
      const catalogRef = catalog([catalogEntry("read", oldRead)]);
      const policy = createPromptBuildToolPolicy({
        session: fixture.session,
        effectiveTools: [{ name: "tool_search" }],
        uncompactedEffectiveTools: tools,
        tools,
        catalogRef,
        codeModeControlsEnabled: false,
      });
      if (hookTiming === "before") {
        policy.apply(["read"]);
      }

      const freshRead = { name: "read", generation: "new" };
      const freshWrite = { name: "write", generation: "new" };
      const freshExec = { name: "exec", generation: "new" };
      tools.splice(0, tools.length, freshRead, freshWrite, freshExec);
      catalogRef.current!.entries = tools.map((tool) => catalogEntry(tool.name, tool));
      fixture.session.setActiveToolsByName(["tool_search"]);
      policy.refresh();
      if (hookTiming === "after") {
        policy.apply(["read"]);
      }

      expect(policy.current.tools).toEqual([freshRead]);
      expect(catalogRef.current!.entries.map((entry) => entry.tool)).toEqual([freshRead]);
      expect(fixture.readNames()).toEqual(["tool_search"]);

      // A subsequent hook revision may use the new full host baseline, never the old generation.
      policy.apply(["write"]);
      expect(catalogRef.current!.entries.map((entry) => entry.tool)).toEqual([freshWrite]);
      expect(logDecisionToolPrefilter).not.toHaveBeenCalled();
    },
  );

  it("removes every submitted tool and catalog entry for an empty hook allowlist", () => {
    const fixture = createSession(["tool_search", "message"]);
    const catalogRef = catalog([catalogEntry("read"), catalogEntry("write")]);

    const result = applyAllow(fixture, [{ name: "read" }, { name: "write" }, { name: "message" }], {
      effectiveTools: [{ name: "tool_search" }, { name: "message" }],
      catalogRef,
    });

    expectSurface(result, []);
    expect(catalogRef.current?.entries).toEqual([]);
    expect(fixture.readNames()).toEqual([]);
    expect(finalize(result.activeToolNames)).toBe("cron:false");
  });

  it("keeps host-required tools when a hook denies optional tools", () => {
    const fixture = createSession(["message", "read"]);

    const result = applyAllow(fixture, [{ name: "message" }, { name: "read" }], {
      forceToolNames: ["message"],
    });

    expectSurface(result, ["message"]);
    expect(finalize(result.activeToolNames)).toBe("cron:true");
  });

  it("cannot add a tool that the host-resolved surface already removed", () => {
    const fixture = createSession(["read"]);

    const result = applyAllow(fixture, [{ name: "read" }], {
      toolsAllow: ["exec"],
    });

    expectSurface(result, []);
  });

  it("keeps cataloged plugin tools allowed through the plugin group", () => {
    const pluginTool = {
      name: "plugin_lookup",
      execute: vi.fn(),
    } as unknown as AnyAgentTool;
    setPluginToolMeta(pluginTool, { pluginId: "example", optional: false });
    const fixture = createSession(["tool_search"]);
    const catalogRef = catalog([catalogEntry(pluginTool.name, pluginTool)]);

    const result = applyAllow(fixture, [pluginTool], {
      toolsAllow: ["group:plugins"],
      effectiveTools: [{ name: "tool_search" }],
      catalogRef,
    });

    expect(result.activeToolNames).toEqual(["tool_search"]);
    expect(result.effectiveTools).toEqual([{ name: "tool_search" }]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["plugin_lookup"]);
  });
});
