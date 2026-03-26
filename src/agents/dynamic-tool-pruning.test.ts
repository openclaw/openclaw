import { describe, expect, it } from "vitest";
import { pruneToolsForPrompt } from "./dynamic-tool-pruning.js";

const makeTool = (name: string, schemaWidth = 1) => ({
  name,
  description: `${name} description`,
  parameters: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: schemaWidth }, (_, index) => [`field${index + 1}`, { type: "string" }]),
    ),
  },
});

describe("pruneToolsForPrompt", () => {
  it("prunes web, messaging, and mutation tools for read-only coding prompts", () => {
    const result = pruneToolsForPrompt({
      taskProfile: "coding",
      promptText: "Explain how src/version.ts works without changing any files.",
      tools: [
        makeTool("read"),
        makeTool("exec"),
        makeTool("write"),
        makeTool("edit"),
        makeTool("browser", 10),
        makeTool("web_search", 8),
        makeTool("message"),
      ] as never,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "exec"]);
    expect(result.report.prunedCount).toBe(5);
    expect(result.report.entries.map((entry) => entry.name)).toEqual([
      "browser",
      "web_search",
      "message",
      "write",
      "edit",
    ]);
  });

  it("keeps web tools for research prompts", () => {
    const result = pruneToolsForPrompt({
      taskProfile: "research",
      promptText: "Research the latest OpenClaw changes on the web.",
      tools: [
        makeTool("read"),
        makeTool("browser"),
        makeTool("web_search"),
        makeTool("web_fetch"),
      ] as never,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "read",
      "browser",
      "web_search",
      "web_fetch",
    ]);
    expect(result.report.prunedCount).toBe(0);
  });
});
