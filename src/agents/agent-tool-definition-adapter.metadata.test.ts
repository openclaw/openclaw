import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { isCodeModeControlTool, markCodeModeControlTool } from "./code-mode-control-tools.js";
import {
  collectRegisteredToolNames,
  toSessionToolAllowlist,
} from "./embedded-agent-runner/tool-name-allowlist.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

describe("session tool definition metadata", () => {
  const tools = [
    createStubTool("read"),
    createStubTool("exec"),
    createStubTool("edit"),
    createStubTool("write"),
    createStubTool("browser"),
  ];

  it("preserves all registered tools in session definitions", () => {
    const customTools = toToolDefinitions(tools, undefined, undefined);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("preserves channel-progress visibility metadata", () => {
    const hiddenWait = {
      ...createStubTool("wait"),
      hideFromChannelProgress: true,
    };
    const customTools = toToolDefinitions(
      [hiddenWait, createStubTool("plugin_wait")],
      undefined,
      undefined,
    );

    expect(customTools[0]).toMatchObject({
      name: "wait",
      hideFromChannelProgress: true,
    });
    expect(customTools[1]).not.toHaveProperty("hideFromChannelProgress");
  });

  it("preserves Code Mode control identity through both production adapters", () => {
    const source = markCodeModeControlTool(createStubTool("exec"));
    const customTools = toToolDefinitions([source], undefined, undefined);
    const definition = customTools[0];
    if (!definition) {
      throw new Error("missing converted Code Mode tool");
    }

    expect(isCodeModeControlTool(definition)).toBe(true);
    expect(isCodeModeControlTool(wrapToolDefinition(definition))).toBe(true);
  });

  it("keeps OpenClaw-managed custom tools in OpenClaw runtime's session allowlist", () => {
    // Session tools are OpenClaw-managed custom tools; dropping them from the
    // allowlist would break inter-agent routing even when sandboxing is enabled.
    const customTools = toToolDefinitions(
      [createStubTool("read"), createStubTool("sessions_spawn")],
      undefined,
      undefined,
    );
    const allowlist = toSessionToolAllowlist(collectRegisteredToolNames(customTools));

    expect(customTools.map((tool) => tool.name)).toContain("sessions_spawn");
    expect(allowlist).toContain("sessions_spawn");
  });
});
