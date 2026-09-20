import { vi } from "vitest";

export function createMockToolDefinitions(tools: unknown[] = []) {
  return tools.map((tool) => {
    const source = tool && typeof tool === "object" ? (tool as Record<string, unknown>) : {};
    const name = typeof source.name === "string" && source.name.length > 0 ? source.name : "tool";
    return {
      name,
      label: source.label ?? name,
      description: source.description ?? "",
      parameters: source.parameters,
      execute: source.execute ?? vi.fn(),
    };
  });
}
