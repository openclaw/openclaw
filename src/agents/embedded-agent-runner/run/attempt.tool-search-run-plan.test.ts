import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { markCodeModeControlTool } from "../../code-mode-control-tools.js";
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
  it.each([
    { label: "shell exec", entries: ["exec"] },
    { label: "shell alias", entries: ["bash"] },
    { label: "maintenance tools", entries: ["read", "write", "exec", "process"] },
  ])("does not count an empty Code Mode bridge as $label", ({ entries }) => {
    const result = plan({
      visibleTools: [markCodeModeControlTool(tool("exec")), markCodeModeControlTool(tool("wait"))],
      clientTools: [],
      controlNames: ["exec", "wait"],
      explicitAllowlistSources: [{ entries }],
    });
    expect(result.hasCallableTools).toBe(false);
  });

  it("counts provider-native tools without exposing them as local functions", () => {
    const result = plan({
      visibleTools: [markCodeModeControlTool(tool("exec")), markCodeModeControlTool(tool("wait"))],
      clientTools: [],
      controlNames: ["exec", "wait"],
      explicitAllowlistSources: [{ entries: ["web_search", "exec"] }],
      hasProviderNativeTools: true,
    });
    expect(result.hasCallableTools).toBe(true);
    expect([...result.liveAllowedToolNames]).toEqual(["exec", "wait"]);
    expect(result.capabilityToolNames.has("web_search")).toBe(false);
  });

  it("counts a real directly exposed shell exec", () => {
    const result = plan({
      visibleTools: [tool("exec")],
      clientTools: [],
      controlsEnabled: false,
      explicitAllowlistSources: [{ entries: ["exec"] }],
    });
    expect(result.hasCallableTools).toBe(true);
  });

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
    { name: "explicit client", cataloged: true, entries: ["client_pick_file"] },
    { name: "wildcard directory client", cataloged: false, entries: ["client_*"] },
    { name: "explicit control", cataloged: true, entries: ["tool_call"] },
  ])("recognizes $name as callable", ({ cataloged, entries }) => {
    const result = plan({
      clientToolsCataloged: cataloged,
      deferredToolsCallable: !cataloged,
      explicitAllowlistSources: [{ entries }],
    });
    expect([...result.visibleAllowedToolNames]).toEqual(
      cataloged ? ["tool_call"] : ["tool_call", "client_pick_file"],
    );
    expect(result.hasCallableTools).toBe(true);
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
