import { describe, expect, it } from "vitest";
import { readQaBootstrapScenarioCatalog, readQaScenarioPack } from "./scenario-catalog.js";

describe("qa scenario catalog", () => {
  it("loads the markdown pack as the canonical source of truth", () => {
    const pack = readQaScenarioPack();

    expect(pack.version).toBe(1);
    expect(pack.agent.identityMarkdown).toContain("Dev C-3PO");
    expect(pack.kickoffTask).toContain("Lobster Invaders");
    expect(pack.scenarios.some((scenario) => scenario.id === "image-generation-roundtrip")).toBe(
      true,
    );
    expect(pack.scenarios.every((scenario) => scenario.execution?.kind === "custom")).toBe(true);
  });

  it("exposes bootstrap data from the markdown pack", () => {
    const catalog = readQaBootstrapScenarioCatalog();

    expect(catalog.agentIdentityMarkdown).toContain("protocol-minded");
    expect(catalog.kickoffTask).toContain("Track what worked");
    expect(catalog.scenarios.some((scenario) => scenario.id === "subagent-fanout-synthesis")).toBe(
      true,
    );
  });
});
