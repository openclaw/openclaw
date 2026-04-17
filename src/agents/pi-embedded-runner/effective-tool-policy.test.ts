import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../tools/common.js";
import { applyFinalEffectiveToolPolicy } from "./effective-tool-policy.js";

function makeTool(name: string, ownerOnly = false): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    ownerOnly,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

describe("applyFinalEffectiveToolPolicy", () => {
  it("filters bundled tools through the configured allowlist", () => {
    const filtered = applyFinalEffectiveToolPolicy({
      tools: [makeTool("message"), makeTool("mcp__bundle__fs_delete")],
      config: { tools: { allow: ["message"] } },
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["message"]);
  });

  it("applies owner-only filtering after bundle tools are merged", () => {
    const filtered = applyFinalEffectiveToolPolicy({
      tools: [makeTool("message"), makeTool("mcp__bundle__admin", true)],
      senderIsOwner: false,
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["message"]);
  });
});
