import { vi } from "vitest";
import type { createOpenClawCodingToolsInternal } from "../agent-tools.js";

function createMockToolDefinitions(tools: unknown[] = []) {
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

export function mockCompactHooksTools(createTools: typeof createOpenClawCodingToolsInternal) {
  vi.doMock("../agent-tools.js", () => ({
    createOpenClawCodingTools: createTools,
    createOpenClawCodingToolsInternal: createTools,
  }));

  vi.doMock("./tool-schema-runtime.js", () => ({
    logProviderToolSchemaDiagnostics: vi.fn(),
    normalizeProviderToolSchemas: vi.fn(({ tools }: { tools: unknown[] }) => tools),
  }));

  vi.doMock("./tool-split.js", () => ({
    splitSdkTools: vi.fn(({ tools }: { tools?: unknown[] }) => ({
      customTools: createMockToolDefinitions(tools),
    })),
  }));
}
