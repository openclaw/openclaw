import { describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import type { ToolSearchCatalogEntry, ToolSearchCatalogRef } from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  applyPromptBuildToolsAllow,
  applyResolvedToolPromptFinalizer,
  createPromptBuildToolPolicy,
} from "./attempt-prompt-support.js";

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
    },
  );

  it.each(["structured", "search", "code"] as const)(
    "withdraws only the Decision cap from the latest permitted %s generation",
    async (mode) => {
      const control = mode === "search" ? "tool_search" : "exec";
      const fixture = createSession(
        mode === "structured" ? ["read", "write", "message"] : [control, "message"],
      );
      const tools = [
        { name: "read", generation: "old" },
        { name: "write", generation: "old" },
        { name: "message", generation: "old" },
      ];
      const effective =
        mode === "structured" ? tools : [{ name: control, generation: "old" }, tools[2]!];
      const catalogRef: ToolSearchCatalogRef | undefined =
        mode === "structured"
          ? undefined
          : {
              current: {
                entries: tools.slice(0, 2).map((t) => catalogEntry(t.name, t)),
                counterScope: "revocation",
                searchCount: 0,
                describeCount: 0,
                callCount: 0,
              },
            };
      const policy = createPromptBuildToolPolicy({
        session: fixture.session,
        effectiveTools: effective,
        uncompactedEffectiveTools: tools,
        tools,
        catalogRef,
        codeModeControlsEnabled: mode === "code",
        forceToolNames: ["message", "denied"],
      });
      let current = true;
      policy.apply(["read"], () => current);
      expect(policy.current.tools.map((t) => t.name)).toEqual(["message"]);
      // A permission publication installs a new baseline while the optional cap is active.
      const freshRead = { name: "read", generation: "new" };
      const freshMessage = { name: "message", generation: "new" };
      tools.splice(0, tools.length, freshRead, freshMessage, { name: "other", generation: "new" });
      if (catalogRef?.current) {
        catalogRef.current.entries = [
          catalogEntry("read", freshRead),
          catalogEntry("other", tools[2]!),
        ];
      }
      fixture.session.setActiveToolsByName(
        mode === "structured" ? ["read", "message", "other"] : [control, "message"],
      );
      policy.refresh();
      current = false;
      const prepare = vi.fn(async () => {});
      await policy.prepareForDispatch(prepare);
      expect(prepare).toHaveBeenCalledOnce();
      expect(policy.current.tools).toEqual([freshRead, freshMessage]);
      expect(policy.current.callableToolNames).toContain("read");
      expect(policy.current.callableToolNames).not.toContain("write");
      expect(policy.current.callableToolNames).not.toContain("other");
      expect(policy.current.callableToolNames).not.toContain("denied");
      if (catalogRef) {
        expect(catalogRef.current?.entries.map((e) => e.tool)).toEqual([freshRead]);
      }
      expect(policy.prepareForDispatch(prepare)).toBeUndefined();
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it("finalizes prompt guidance from an empty submitted surface", () => {
    const finalize = vi.fn(
      ({ prompt, messageToolAvailable }: { prompt: string; messageToolAvailable: boolean }) =>
        `${prompt}:${messageToolAvailable}`,
    );

    expect(
      applyResolvedToolPromptFinalizer({
        prompt: "cron",
        activeToolNames: [],
        finalize,
      }),
    ).toBe("cron:false");
    expect(finalize).toHaveBeenCalledWith({
      prompt: "cron",
      messageToolAvailable: false,
    });
  });

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

  it("keeps search controls only for catalog entries allowed by the hook", () => {
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
      toolsAllow: ["read"],
      baseline: createBaseline(fixture.readNames(), catalogRef),
      effectiveTools: [{ name: "tool_search" }, { name: "message" }],
      uncompactedEffectiveTools: [{ name: "read" }, { name: "write" }, { name: "message" }],
      tools: [{ name: "read" }, { name: "write" }, { name: "message" }],
      catalogRef,
      codeModeControlsEnabled: false,
    });

    expect(result.activeToolNames).toEqual(["tool_search"]);
    expect(result.effectiveTools).toEqual([{ name: "tool_search" }]);
    expect(result.uncompactedEffectiveTools).toEqual([{ name: "read" }]);
    expect(result.tools).toEqual([{ name: "read" }]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["read"]);
    expect(fixture.readNames()).toEqual(["tool_search"]);
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

  it("derives each prompt restriction from the preserved host baseline", () => {
    const fixture = createSession(["tool_search"]);
    const catalogRef: ToolSearchCatalogRef = {
      current: {
        entries: [catalogEntry("read"), catalogEntry("write")],
        counterScope: "scope-1",
        searchCount: 2,
        describeCount: 1,
        callCount: 3,
      },
    };
    const baseline = createBaseline(fixture.readNames(), catalogRef);
    const params = {
      session: fixture.session,
      baseline,
      effectiveTools: [{ name: "tool_search" }],
      uncompactedEffectiveTools: [{ name: "read" }, { name: "write" }],
      tools: [{ name: "read" }, { name: "write" }],
      catalogRef,
      codeModeControlsEnabled: false,
    };

    applyPromptBuildToolsAllow({ ...params, toolsAllow: ["read"] });
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["read"]);
    expect(catalogRef.current?.counterScope).toBe("scope-1");

    const writeOnly = applyPromptBuildToolsAllow({ ...params, toolsAllow: ["write"] });
    expect(writeOnly.tools).toEqual([{ name: "write" }]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["write"]);
    expect(catalogRef.current?.counterScope).toBe("scope-1");

    const restored = applyPromptBuildToolsAllow(params);
    expect(restored.tools).toEqual([{ name: "read" }, { name: "write" }]);
    expect(catalogRef.current).toMatchObject({
      entries: baseline.catalogEntries,
      counterScope: "scope-1",
      searchCount: 2,
      describeCount: 1,
      callCount: 3,
    });
  });
});
