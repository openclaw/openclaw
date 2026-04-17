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
      bundledTools: [makeTool("mcp__bundle__fs_delete"), makeTool("mcp__bundle__fs_read")],
      config: { tools: { allow: ["mcp__bundle__fs_read"] } },
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__fs_read"]);
  });

  it("applies owner-only filtering to bundled tools", () => {
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__read"), makeTool("mcp__bundle__admin", true)],
      senderIsOwner: false,
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__read"]);
  });

  it("returns the empty array unchanged when there are no bundled tools", () => {
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: [],
      config: { tools: { allow: ["message"] } },
      warn: () => {},
    });

    expect(filtered).toEqual([]);
  });

  it("drops caller-provided groupId when it disagrees with session-derived group context", () => {
    const warnings: string[] = [];
    applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      // Session key encodes a concrete group (discord room 111); caller tries
      // to override with a different group id so a more permissive group
      // policy for group 222 could be consulted.
      sessionKey: "agent:alice:discord:group:111",
      groupId: "222",
      groupChannel: "#different",
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toContain(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  });
});
