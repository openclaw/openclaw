import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { buildToolSearchRunPlan } from "./attempt-tool-search-run-plan.js";

const tool = (name: string): AnyAgentTool => ({
  name,
  label: name,
  description: "Tool inventory fixture",
  parameters: Type.Object({}),
  execute: async () => ({ content: [], details: undefined }),
});
const clientTools = [
  {
    type: "function" as const,
    function: {
      name: "client_pick_file",
      parameters: { type: "object", properties: {} },
    },
  },
];
function plan(overrides: Partial<Parameters<typeof buildToolSearchRunPlan>[0]> = {}) {
  return buildToolSearchRunPlan({
    visibleTools: [tool("tool_call")],
    uncompactedTools: [],
    clientTools,
    clientToolsCataloged: true,
    catalogToolCount: 0,
    controlsEnabled: true,
    explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    ...overrides,
  });
}

describe("buildToolSearchRunPlan", () => {
  it("carries native catalog capabilities without widening direct execution authority", () => {
    const foreignTool = tool("sessions_yield");
    setPluginToolMeta(foreignTool, { pluginId: "bundle-mcp", optional: false });
    const catalog = [tool("sessions_spawn"), foreignTool];
    const result = plan({
      visibleTools: [tool("exec"), tool("wait")],
      uncompactedTools: catalog,
      catalogCapabilityTools: catalog,
      catalogToolCount: 2,
      controlNames: ["exec", "wait"],
      deferredToolsCallable: false,
      explicitAllowlistSources: [],
    });
    expect([...result.visibleAllowedToolNames]).toEqual(["exec", "wait"]);
    expect(result.liveAllowedToolNames).toBe(result.visibleAllowedToolNames);
    expect([...result.replayAllowedToolNames]).toEqual([
      "sessions_spawn",
      "sessions_yield",
      "client_pick_file",
      "exec",
      "wait",
    ]);
    expect([...result.capabilityToolNames]).toEqual(["exec", "wait", "sessions_spawn"]);
    expect(result.hasCallableTools).toBe(true);
  });

  it.each([
    {
      name: "cataloged unrelated client",
      cataloged: true,
      entries: ["missing_tool"],
      callable: false,
    },
    {
      name: "visible unrelated client",
      cataloged: false,
      entries: ["missing_tool"],
      callable: false,
    },
    { name: "explicit client", cataloged: true, entries: ["client_pick_file"], callable: true },
    { name: "wildcard directory client", cataloged: false, entries: ["client_*"], callable: true },
    { name: "explicit control", cataloged: true, entries: ["tool_call"], callable: true },
  ])("counts $name without masking an empty allowlist", ({ cataloged, entries, callable }) => {
    const result = plan({
      clientToolsCataloged: cataloged,
      deferredToolsCallable: !cataloged,
      explicitAllowlistSources: [{ entries }],
    });
    expect([...result.visibleAllowedToolNames]).toEqual(
      cataloged ? ["tool_call"] : ["tool_call", "client_pick_file"],
    );
    expect(result.hasCallableTools).toBe(callable);
  });

  it("keeps ambiguous deferred names replayable but not directly callable", () => {
    const result = plan({
      visibleTools: [tool("tool_search"), tool("tool_describe"), tool("tool_call")],
      uncompactedTools: [tool("fake_plugin_tool"), tool("sessions_spawn"), tool("sessions_spawn")],
      clientToolsCataloged: false,
      catalogToolCount: 3,
      deferredToolsCallable: true,
      explicitAllowlistSources: [],
    });
    expect([...result.liveAllowedToolNames]).toEqual([
      "fake_plugin_tool",
      "tool_search",
      "tool_describe",
      "tool_call",
      "client_pick_file",
    ]);
    expect([...result.replayAllowedToolNames]).toContain("sessions_spawn");
    expect([...result.capabilityToolNames]).toEqual(["fake_plugin_tool", "sessions_spawn"]);
  });
});
