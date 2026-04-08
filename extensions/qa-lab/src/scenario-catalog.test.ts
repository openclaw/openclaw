import { describe, expect, it } from "vitest";
import {
  listQaScenarioMarkdownPaths,
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
} from "./scenario-catalog.js";

describe("qa scenario catalog", () => {
  it("loads the markdown pack as the canonical source of truth", () => {
    const pack = readQaScenarioPack();

    expect(pack.version).toBe(1);
    expect(pack.agent.identityMarkdown).toContain("Dev C-3PO");
    expect(pack.kickoffTask).toContain("Lobster Invaders");
    expect(listQaScenarioMarkdownPaths().length).toBe(pack.scenarios.length);
    expect(pack.scenarios.some((scenario) => scenario.id === "image-generation-roundtrip")).toBe(
      true,
    );
    expect(pack.scenarios.some((scenario) => scenario.id === "character-vibes-gollum")).toBe(true);
    expect(pack.scenarios.every((scenario) => scenario.execution?.kind === "flow")).toBe(true);
    expect(pack.scenarios.some((scenario) => scenario.execution.flow?.steps.length)).toBe(true);
  });

  it("exposes bootstrap data from the markdown pack", () => {
    const catalog = readQaBootstrapScenarioCatalog();

    expect(catalog.agentIdentityMarkdown).toContain("protocol-minded");
    expect(catalog.kickoffTask).toContain("Track what worked");
    expect(catalog.scenarios.some((scenario) => scenario.id === "subagent-fanout-synthesis")).toBe(
      true,
    );
  });

  it("loads scenario-specific execution config from per-scenario markdown", () => {
    const discovery = readQaScenarioById("source-docs-discovery-report");
    const discoveryConfig = readQaScenarioExecutionConfig("source-docs-discovery-report");
    const fallbackConfig = readQaScenarioExecutionConfig("memory-failure-fallback");

    expect(discovery.title).toBe("Source and docs discovery report");
    expect((discoveryConfig?.requiredFiles as string[] | undefined)?.[0]).toBe(
      "repo/qa/scenarios/index.md",
    );
    expect(fallbackConfig?.gracefulFallbackAny as string[] | undefined).toContain(
      "will not reveal",
    );
  });
});
