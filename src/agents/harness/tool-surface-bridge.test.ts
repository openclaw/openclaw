import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAgentHarnessToolSurfaceRuntime } from "./tool-surface-bridge.js";

function tools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({
    name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  })) as AnyAgentTool[];
}

describe("createAgentHarnessToolSurfaceRuntime", () => {
  it("filters raw SDK tools but does not refilter prepared constructor output", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: true } } },
      tools: { alsoAllow: ["image_generate"], toolSearch: { enabled: false } },
    };
    const runtime = createAgentHarnessToolSurfaceRuntime({
      config,
      executeTool: async () => ({ content: [] }),
      modelToolsEnabled: true,
    });

    expect(
      runtime
        .compactTools(tools(["read", "browser", "image_generate"]))
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "image_generate"]);
    expect(
      runtime
        .compactTools(tools(["read", "browser"]), { localModelLeanApplied: true })
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "browser"]);
    runtime.cleanup();
  });
});
