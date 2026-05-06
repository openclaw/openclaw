import { describe, it, expect } from "vitest";
import { createActiveRuntimeRegistry, registerMedia } from "./active-registry";
import {
  createToolResultProcessor,
  processToolResult,
  type ToolResultContext,
} from "./tool-result-middleware";

describe("tool result middleware", () => {
  it("creates processor", () => {
    const processor = createToolResultProcessor();
    expect(processor).toBeDefined();
  });

  it("returns should not process when no media provider specified", () => {
    const processor = createToolResultProcessor();
    const registry = createActiveRuntimeRegistry();
    const context: ToolResultContext = {
      toolName: "test-tool",
      isSuccess: true,
    };

    const decision = processor(context, registry);
    expect(decision.shouldProcess).toBe(false);
  });

  it("returns should not process when media provider not found", () => {
    const processor = createToolResultProcessor();
    const registry = createActiveRuntimeRegistry();
    const context: ToolResultContext = {
      toolName: "test-tool",
      isSuccess: true,
      mediaProvider: "missing-provider",
    };

    const decision = processor(context, registry);
    expect(decision.shouldProcess).toBe(false);
    expect(decision.processingHint).toContain("not found");
  });

  it("returns should process when media provider found", () => {
    const processor = createToolResultProcessor();
    const registry = createActiveRuntimeRegistry();
    registerMedia(registry, "vision-provider", {
      providerId: "azure-vision",
    });

    const context: ToolResultContext = {
      toolName: "analyze-image",
      isSuccess: true,
      mediaProvider: "vision-provider",
    };

    const decision = processor(context, registry);
    expect(decision.shouldProcess).toBe(true);
    expect(decision.processingHint).toContain("azure-vision");
  });

  it("processes tool result with prepared media provider", () => {
    const processor = createToolResultProcessor();
    const registry = createActiveRuntimeRegistry();
    registerMedia(registry, "vision", { providerId: "azure-vision" });

    const context: ToolResultContext = {
      toolName: "analyze",
      isSuccess: true,
      mediaProvider: "vision",
      contentType: "image/jpeg",
    };

    const result = processToolResult({}, processor, context, registry);
    expect(result.processed).toBe(true);
    expect(result.metadata?.hint).toContain("azure-vision");
  });

  it("does not process without media provider", () => {
    const processor = createToolResultProcessor();
    const registry = createActiveRuntimeRegistry();

    const context: ToolResultContext = {
      toolName: "generic-tool",
      isSuccess: true,
    };

    const result = processToolResult({}, processor, context, registry);
    expect(result.processed).toBe(false);
  });
});
