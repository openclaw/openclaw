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

function createBaseline(activeToolNames: string[], catalogRef?: ToolSearchCatalogRef) {
  return {
    activeToolNames,
    catalogEntries: [...(catalogRef?.current?.entries ?? [])],
  };
}

describe("applyPromptBuildToolsAllow", () => {
  it.each(["before", "after"] as const)(
    "keeps hook-denied tools fenced when the hook resolves %s a permission change",
    (hookTiming) => {
      const fixture = createSession(["tool_search"]);
      const oldRead = { name: "read", generation: "old" };
      const tools = [oldRead];
      const catalogRef: ToolSearchCatalogRef = {
        current: {
          entries: [catalogEntry("read", oldRead)],
          counterScope: "permissions",
          searchCount: 0,
          describeCount: 0,
          callCount: 0,
        },
      };
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
    const catalogRef: ToolSearchCatalogRef = {
      current: {
        entries: [catalogEntry("read"), catalogEntry("write")],
        counterScope: "scope-1",
        searchCount: 0,
        describeCount: 0,
        callCount: 0,
      },
    };

    const result = applyPromptBuildToolsAllow({
      session: fixture.session,
      toolsAllow: [],
      baseline: createBaseline(fixture.readNames(), catalogRef),
      effectiveTools: [{ name: "tool_search" }, { name: "message" }],
      uncompactedEffectiveTools: [{ name: "read" }, { name: "write" }, { name: "message" }],
      tools: [{ name: "read" }, { name: "write" }, { name: "message" }],
      catalogRef,
      codeModeControlsEnabled: false,
    });

    expect(result.activeToolNames).toEqual([]);
    expect(result.effectiveTools).toEqual([]);
    expect(result.uncompactedEffectiveTools).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(catalogRef.current?.entries).toEqual([]);
    expect(fixture.readNames()).toEqual([]);
    expect(
      applyResolvedToolPromptFinalizer({
        prompt: "cron",
        activeToolNames: result.activeToolNames,
        finalize: ({ prompt, messageToolAvailable }) => `${prompt}:${messageToolAvailable}`,
      }),
    ).toBe("cron:false");
  });

  it("keeps host-required tools when a hook denies optional tools", () => {
    const fixture = createSession(["message", "read"]);

    const result = applyPromptBuildToolsAllow({
      session: fixture.session,
      toolsAllow: [],
      forceToolNames: ["message"],
      baseline: createBaseline(fixture.readNames()),
      effectiveTools: [{ name: "message" }, { name: "read" }],
      uncompactedEffectiveTools: [{ name: "message" }, { name: "read" }],
      tools: [{ name: "message" }, { name: "read" }],
      codeModeControlsEnabled: false,
    });

    expect(result.activeToolNames).toEqual(["message"]);
    expect(result.effectiveTools).toEqual([{ name: "message" }]);
    expect(result.uncompactedEffectiveTools).toEqual([{ name: "message" }]);
    expect(result.tools).toEqual([{ name: "message" }]);
    expect(
      applyResolvedToolPromptFinalizer({
        prompt: "cron",
        activeToolNames: result.activeToolNames,
        finalize: ({ prompt, messageToolAvailable }) => `${prompt}:${messageToolAvailable}`,
      }),
    ).toBe("cron:true");
  });

  it("cannot add a tool that the host-resolved surface already removed", () => {
    const fixture = createSession(["read"]);

    const result = applyPromptBuildToolsAllow({
      session: fixture.session,
      toolsAllow: ["exec"],
      baseline: createBaseline(fixture.readNames()),
      effectiveTools: [{ name: "read" }],
      uncompactedEffectiveTools: [{ name: "read" }],
      tools: [{ name: "read" }],
      codeModeControlsEnabled: false,
    });

    expect(result.activeToolNames).toEqual([]);
    expect(result.effectiveTools).toEqual([]);
    expect(result.uncompactedEffectiveTools).toEqual([]);
    expect(result.tools).toEqual([]);
  });

  it("keeps cataloged plugin tools allowed through the plugin group", () => {
    const pluginTool = {
      name: "plugin_lookup",
      execute: vi.fn(),
    } as unknown as AnyAgentTool;
    setPluginToolMeta(pluginTool, { pluginId: "example", optional: false });
    const fixture = createSession(["tool_search"]);
    const catalogRef: ToolSearchCatalogRef = {
      current: {
        entries: [catalogEntry(pluginTool.name, pluginTool)],
        counterScope: "scope-1",
        searchCount: 0,
        describeCount: 0,
        callCount: 0,
      },
    };

    const result = applyPromptBuildToolsAllow({
      session: fixture.session,
      toolsAllow: ["group:plugins"],
      baseline: createBaseline(fixture.readNames(), catalogRef),
      effectiveTools: [{ name: "tool_search" }],
      uncompactedEffectiveTools: [pluginTool],
      tools: [pluginTool],
      catalogRef,
      codeModeControlsEnabled: false,
    });

    expect(result.activeToolNames).toEqual(["tool_search"]);
    expect(result.effectiveTools).toEqual([{ name: "tool_search" }]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["plugin_lookup"]);
  });
});
