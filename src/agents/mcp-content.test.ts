import { describe, expect, it } from "vitest";
import { projectMcpCallToolResult } from "./mcp-content.js";

function nestedStructuredContent(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

describe("projectMcpCallToolResult", () => {
  it("mirrors an ordinary structuredContent for the model", () => {
    const result = projectMcpCallToolResult({
      content: [],
      structuredContent: { answer: 42 },
    });

    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{\n  "answer": 42\n}' },
    ]);
    expect(result.details).toMatchObject({ structuredContent: { answer: 42 } });
    expect((result.details as { status?: string }).status).toBeUndefined();
  });

  it("degrades a deeply nested structuredContent to a handled failure", () => {
    // Serializing this value recurses per level; the depth is far past every
    // engine's stack limit, which is what makes the remote MCP payload fatal.
    const structuredContent = nestedStructuredContent(100_000);

    const result = projectMcpCallToolResult({ content: [], structuredContent });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "structuredContent was too deeply nested to project. Ask the MCP server for a flatter result or query a specific field.",
      },
    ]);
    expect(result.details).toMatchObject({ status: "error" });
    // Retained details feed recursive digests downstream (loop detection), so the
    // unprojectable value must not survive into them.
    expect(result.details).not.toHaveProperty("structuredContent");
  });

  it("keeps server content blocks beside the unprojectable notice", () => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text: "recovery guidance" }],
      structuredContent: nestedStructuredContent(100_000),
    });

    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("too deeply nested") },
      { type: "text", text: "recovery guidance" },
    ]);
  });

  it("keeps reporting a server-declared error for shallow content", () => {
    const result = projectMcpCallToolResult({
      content: [],
      structuredContent: { answer: 42 },
      isError: true,
    });

    expect(result.details).toMatchObject({ status: "error" });
    expect(result.details).toHaveProperty("structuredContent");
  });
});
