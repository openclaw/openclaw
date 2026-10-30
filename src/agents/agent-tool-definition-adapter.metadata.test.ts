import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { isCodeModeControlTool, markCodeModeControlTool } from "./code-mode-control-tools.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

describe("session tool definition metadata", () => {
  it("preserves progress visibility and Code Mode identity through session adaptation", () => {
    const customTools = toToolDefinitions([
      { ...createStubTool("wait"), hideFromChannelProgress: true },
      createStubTool("plugin_wait"),
      markCodeModeControlTool(createStubTool("exec")),
    ]);

    expect(customTools[0]).toMatchObject({
      name: "wait",
      hideFromChannelProgress: true,
    });
    expect(customTools[1]).not.toHaveProperty("hideFromChannelProgress");
    const definition = customTools[2];
    if (!definition) {
      throw new Error("missing converted Code Mode tool");
    }

    expect(isCodeModeControlTool(definition)).toBe(true);
    expect(isCodeModeControlTool(wrapToolDefinition(definition))).toBe(true);
  });
});
