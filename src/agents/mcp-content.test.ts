import { describe, expect, it } from "vitest";
import { consumeMcpCodeModeGuestResult, projectMcpCallToolResult } from "./mcp-content.js";

function nestedStructuredContent(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

describe("projectMcpCallToolResult", () => {
  it.each([
    { label: "ordinary", deep: false, isError: undefined },
    { label: "server error", deep: false, isError: true },
    { label: "unprojectable", deep: true, isError: false },
  ])("projects $label structured content for model and guest callers", ({ deep, isError }) => {
    const result = projectMcpCallToolResult({
      content: deep ? [{ type: "text", text: "recovery guidance" }] : [],
      structuredContent: deep ? nestedStructuredContent(100_000) : { answer: 42 },
      isError,
    });
    if (deep) {
      const content = [
        {
          type: "text",
          text: "structuredContent was too deeply nested to project. Ask the MCP server for a flatter result or query a specific field.",
        },
        { type: "text", text: "recovery guidance" },
      ];
      expect(result.content).toEqual(content);
      expect(result.details).toEqual({ status: "error" });
      // Recursive downstream digests must not receive the unprojectable value.
      expect(result.details).not.toHaveProperty("structuredContent");
      expect(consumeMcpCodeModeGuestResult(result)).toEqual({ content, isError: true });
    } else {
      expect(result.content).toEqual([{ type: "text", text: 'structuredContent:\n{"answer":42}' }]);
      expect(result.details).toEqual({
        structuredContent: { answer: 42 },
        ...(isError ? { status: "error" } : {}),
      });
    }
  });

  it.each([
    { label: "pretty", text: JSON.stringify({ answer: 42, items: [1, 2] }, null, 2) },
    { label: "compact", text: JSON.stringify({ answer: 42, items: [1, 2] }) },
    { label: "reordered", text: '{"items":[1,2],"answer":42}' },
  ])("drops a $label JSON mirror of structured content", ({ text }) => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text }],
      structuredContent: { answer: 42, items: [1, 2] },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: 'structuredContent:\n{"answer":42,"items":[1,2]}',
      },
    ]);
  });

  const channels = [{ id: "C1", name: "general" }];
  it.each([
    { label: "pretty items-wrapped", key: "items", text: JSON.stringify(channels, null, 1) },
    { label: "compact result-wrapped", key: "result", text: JSON.stringify(channels) },
    { label: "reordered custom-key", key: "rows", text: '[{"name":"general","id":"C1"}]' },
  ])("drops the bare value of a $label array", ({ key, text }) => {
    const structuredContent = { [key]: channels };
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text }],
      structuredContent,
    });
    expect(result.content).toEqual([
      { type: "text", text: `structuredContent:\n{"${key}":[{"id":"C1","name":"general"}]}` },
    ]);
    expect(result.details).toEqual({ structuredContent });
  });

  it.each([
    { label: "number", text: "42", value: 42 },
    { label: "JSON string", text: '"ok"', value: "ok" },
    { label: "plain string", text: "ok", value: "ok" },
  ])("drops a $label mirror of a result-wrapped scalar", ({ text, value }) => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text }],
      structuredContent: { result: value },
    });
    expect(result.content).toEqual([
      { type: "text", text: `structuredContent:\n${JSON.stringify({ result: value })}` },
    ]);
  });

  it("keeps text that is not a JSON mirror of structured content", () => {
    const result = projectMcpCallToolResult({
      content: [
        { type: "text", text: '{"answer":41}' },
        { type: "text", text: '{"answer":42' },
        { type: "text", text: "answer: 42; retry with a narrower query" },
      ],
      structuredContent: { answer: 42 },
    });
    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{"answer":42}' },
      { type: "text", text: '{"answer":41}' },
      { type: "text", text: '{"answer":42' },
      { type: "text", text: "answer: 42; retry with a narrower query" },
    ]);
  });

  it("keeps the wrapped-value text when structured content has more than one key", () => {
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text: "[1,2]" }],
      structuredContent: { items: [1, 2], next: null },
    });
    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{"items":[1,2],"next":null}' },
      { type: "text", text: "[1,2]" },
    ]);
  });

  it("keeps text too deeply nested to compare with structured content", () => {
    const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    const result = projectMcpCallToolResult({
      content: [{ type: "text", text: deep }],
      structuredContent: { items: [] },
    });
    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{"items":[]}' },
      { type: "text", text: deep },
    ]);
  });
});
