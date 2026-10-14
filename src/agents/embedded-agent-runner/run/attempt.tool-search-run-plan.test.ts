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
    visibleTools: [tool("dispatch_action")],
    uncompactedTools: [],
    clientTools,
    catalogedClientToolNames: new Set(["client_pick_file"]),
    catalogToolCount: 0,
    controlsEnabled: true,
    explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    ...overrides,
  });
}

describe("buildToolSearchRunPlan", () => {
  it("does not promote direct MCP or client lookalikes into trusted capability guidance", () => {
    const remote = tool("sessions_spawn");
    setPluginToolMeta(remote, {
      pluginId: "remote-plugin",
      optional: false,
      mcp: {
        serverName: "remote",
        safeServerName: "remote",
        toolName: "spawn",
        operation: "tool",
      },
    });
    const result = plan({
      visibleTools: [remote, tool(" native_direct ")],
      clientTools: [
        { type: "function", function: { name: "sessions_yield", parameters: { type: "object" } } },
      ],
      catalogedClientToolNames: new Set(),
    });
    expect([...result.visibleAllowedToolNames]).toEqual([
      "sessions_spawn",
      "native_direct",
      "sessions_yield",
    ]);
    expect([...result.capabilityToolNames]).toEqual(["native_direct"]);
  });

  it("keeps only deferred client tools out of visible/live allowlists, not replay", () => {
    const result = plan({
      clientTools: [
        ...clientTools,
        { type: "function", function: { name: "client_direct", parameters: { type: "object" } } },
      ],
      explicitAllowlistSources: [],
    });
    expect([...result.visibleAllowedToolNames]).toEqual(["dispatch_action", "client_direct"]);
    expect([...result.liveAllowedToolNames]).toEqual(["dispatch_action", "client_direct"]);
    expect([...result.replayAllowedToolNames]).toEqual([
      "client_pick_file",
      "client_direct",
      "dispatch_action",
    ]);
    // Client names must not advertise trusted native capability guidance.
    expect([...result.capabilityToolNames]).toEqual(["dispatch_action"]);
    expect(result.hasCallableTools).toBe(true);
  });

  it("carries native catalog capabilities without widening direct execution authority", () => {
    const foreignTool = tool("sessions_yield");
    setPluginToolMeta(foreignTool, { pluginId: "bundle-mcp", optional: false });
    const catalog = [tool("sessions_spawn"), foreignTool];
    const result = plan({
      visibleTools: [tool("exec"), tool("wait")],
      uncompactedTools: catalog,
      catalogEntries: [
        { name: "sessions_spawn", source: "openclaw" },
        { name: "sessions_yield", source: "mcp" },
        { name: "client_pick_file", source: "client" },
      ],
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
    { name: "explicit control", cataloged: true, entries: ["dispatch_action"] },
  ])("recognizes $name as callable", ({ cataloged, entries }) => {
    const result = plan({
      catalogedClientToolNames: new Set(cataloged ? ["client_pick_file"] : []),
      deferredToolsCallable: !cataloged,
      explicitAllowlistSources: [{ entries }],
    });
    expect([...result.visibleAllowedToolNames]).toEqual(
      cataloged ? ["dispatch_action"] : ["dispatch_action", "client_pick_file"],
    );
    expect(result.hasCallableTools).toBe(true);
  });

  it("keeps ambiguous deferred names replayable but not directly callable", () => {
    const result = plan({
      visibleTools: [tool("tool_search"), tool("tool_describe"), tool("dispatch_action")],
      uncompactedTools: [tool("fake_plugin_tool"), tool("sessions_spawn"), tool("sessions_spawn")],
      catalogedClientToolNames: new Set(),
      catalogToolCount: 3,
      deferredToolsCallable: true,
      explicitAllowlistSources: [],
    });
    expect([...result.liveAllowedToolNames]).toEqual([
      "fake_plugin_tool",
      "tool_search",
      "tool_describe",
      "dispatch_action",
      "client_pick_file",
    ]);
    expect([...result.replayAllowedToolNames]).toContain("sessions_spawn");
    expect([...result.capabilityToolNames]).toEqual(["fake_plugin_tool", "sessions_spawn"]);
  });
});
