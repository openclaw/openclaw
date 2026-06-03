import { describe, expect, it } from "vitest";
import {
  buildAutoAddedToolSearchControlNamesForAllowlistCheck,
  buildCallableToolNamesForEmptyAllowlistCheck,
  buildToolSearchRunPlan,
} from "./attempt.tool-search-run-plan.js";
import type { ClientToolDefinition } from "./params.js";

function clientTool(name: string): ClientToolDefinition {
  return {
    type: "function",
    function: {
      name,
      parameters: { type: "object", properties: {} },
    },
  };
}

function unreadableClientFunction(message: string): ClientToolDefinition {
  const tool = {} as ClientToolDefinition;
  Object.defineProperty(tool, "function", {
    get() {
      throw new Error(message);
    },
  });
  return tool;
}

function unreadableClientName(message: string): ClientToolDefinition {
  const tool = {
    type: "function",
    function: {},
  } as unknown as ClientToolDefinition;
  Object.defineProperty(tool.function, "name", {
    get() {
      throw new Error(message);
    },
  });
  return tool;
}

function clientToolWithHostileTag(name: string): ClientToolDefinition {
  const tool = clientTool(name);
  Object.defineProperty(tool.function, Symbol.toStringTag, {
    get() {
      throw new Error("fuzzplugin run plan function tag getter exploded");
    },
  });
  return tool;
}

describe("buildCallableToolNamesForEmptyAllowlistCheck", () => {
  it("ignores auto-added Tool Search controls so bad allowlists still fail", () => {
    expect(
      buildCallableToolNamesForEmptyAllowlistCheck({
        effectiveToolNames: ["tool_search_code"],
        autoAddedToolSearchControlNames: new Set(["tool_search_code"]),
        toolSearchCatalogToolCount: 0,
      }),
    ).toEqual([]);
  });

  it("counts cataloged tools hidden behind auto-added Tool Search controls", () => {
    expect(
      buildCallableToolNamesForEmptyAllowlistCheck({
        effectiveToolNames: ["tool_search_code"],
        autoAddedToolSearchControlNames: new Set(["tool_search_code"]),
        toolSearchCatalogToolCount: 1,
      }),
    ).toEqual(["tool-search:0"]);
  });

  it("keeps explicitly requested Tool Search controls callable", () => {
    expect(
      buildCallableToolNamesForEmptyAllowlistCheck({
        effectiveToolNames: ["tool_search_code"],
        autoAddedToolSearchControlNames: new Set(),
        toolSearchCatalogToolCount: 0,
      }),
    ).toEqual(["tool_search_code"]);
  });
});

describe("buildAutoAddedToolSearchControlNamesForAllowlistCheck", () => {
  it("treats controls as auto-added unless any explicit allowlist requested them", () => {
    expect(
      buildAutoAddedToolSearchControlNamesForAllowlistCheck({
        toolSearchControlsEnabled: true,
        explicitAllowlistSources: [{ entries: ["missing_tool"] }],
        controlNames: ["tool_search_code", "tool_search"],
      }),
    ).toEqual(new Set(["tool_search_code", "tool_search"]));

    expect(
      buildAutoAddedToolSearchControlNamesForAllowlistCheck({
        toolSearchControlsEnabled: true,
        explicitAllowlistSources: [{ entries: ["tool_search_code"] }],
        controlNames: ["tool_search_code", "tool_search"],
      }),
    ).toEqual(new Set(["tool_search"]));
  });
});

describe("buildToolSearchRunPlan", () => {
  it("keeps compact visible names separate from replay-safe names", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search_code" }] as never,
      uncompactedTools: [
        { name: "tool_search_code" },
        { name: "exec" },
        { name: "fake_plugin_tool" },
      ] as never,
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      catalogRegistered: true,
      catalogToolCount: 2,
      controlsEnabled: true,
      explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    });

    expect([...plan.visibleAllowedToolNames]).toEqual(["tool_search_code"]);
    expect([...plan.replayAllowedToolNames]).toEqual([
      "tool_search_code",
      "exec",
      "fake_plugin_tool",
      "client_pick_file",
    ]);
    expect(plan.emptyAllowlistCallableNames).toEqual(["tool-search:0", "tool-search:1"]);
  });

  it("counts explicitly allowlisted client tools before they are cataloged later", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search_code" }] as never,
      uncompactedTools: [{ name: "tool_search_code" }] as never,
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      catalogRegistered: true,
      catalogToolCount: 0,
      controlsEnabled: true,
      explicitAllowlistSources: [{ entries: ["client_pick_file"] }],
    });

    expect(plan.emptyAllowlistCallableNames).toEqual(["tool-search-client:client_pick_file"]);
  });

  it("skips unreadable client tool descriptors while preserving readable client names", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search_code" }] as never,
      uncompactedTools: [{ name: "tool_search_code" }] as never,
      clientTools: [
        unreadableClientFunction("fuzzplugin run plan function getter exploded"),
        unreadableClientName("fuzzplugin run plan name getter exploded"),
        clientToolWithHostileTag("client_tagged"),
        clientTool("client_pick_file"),
      ],
      catalogRegistered: true,
      catalogToolCount: 0,
      controlsEnabled: true,
      explicitAllowlistSources: [{ entries: ["client_tagged", "client_pick_file"] }],
    });

    expect([...plan.replayAllowedToolNames]).toEqual([
      "tool_search_code",
      "client_tagged",
      "client_pick_file",
    ]);
    expect(plan.emptyAllowlistCallableNames).toEqual([
      "tool-search-client:client_tagged",
      "tool-search-client:client_pick_file",
    ]);
  });

  it("keeps code-mode control tools in replay-safe names", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "exec" }, { name: "wait" }] as never,
      uncompactedTools: [{ name: "fake_plugin_tool" }] as never,
      clientTools: [],
      catalogRegistered: true,
      catalogToolCount: 1,
      controlsEnabled: true,
      controlNames: ["exec", "wait"],
      explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    });

    expect([...plan.visibleAllowedToolNames]).toEqual(["exec", "wait"]);
    expect([...plan.replayAllowedToolNames]).toEqual(["fake_plugin_tool", "exec", "wait"]);
    expect(plan.emptyAllowlistCallableNames).toEqual(["tool-search:0"]);
  });

  it("does not let unrelated client tools mask a bad explicit allowlist", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search_code" }] as never,
      uncompactedTools: [{ name: "tool_search_code" }] as never,
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      catalogRegistered: true,
      catalogToolCount: 0,
      controlsEnabled: true,
      explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    });

    expect(plan.emptyAllowlistCallableNames).toEqual([]);
  });
});
