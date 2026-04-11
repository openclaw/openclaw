import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isQaScenarioPackAvailable,
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
    expect(pack.scenarios.some((scenario) => scenario.id === "character-vibes-c3po")).toBe(true);
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
    const bundledSkill = readQaScenarioById("bundled-plugin-skill-runtime");
    const bundledSkillConfig = readQaScenarioExecutionConfig("bundled-plugin-skill-runtime") as
      | { pluginId?: string; expectedSkillName?: string }
      | undefined;
    const fanoutConfig = readQaScenarioExecutionConfig("subagent-fanout-synthesis") as
      | { expectedReplyGroups?: unknown[][] }
      | undefined;

    expect(discovery.title).toBe("Source and docs discovery report");
    expect((discoveryConfig?.requiredFiles as string[] | undefined)?.[0]).toBe(
      "repo/qa/scenarios/index.md",
    );
    expect(fallbackConfig?.gracefulFallbackAny as string[] | undefined).toContain(
      "will not reveal",
    );
    expect(bundledSkill.title).toBe("Bundled plugin skill runtime");
    expect(bundledSkillConfig?.pluginId).toBe("open-prose");
    expect(bundledSkillConfig?.expectedSkillName).toBe("prose");
    expect(fanoutConfig?.expectedReplyGroups?.flat()).toContain("subagent-1: ok");
    expect(fanoutConfig?.expectedReplyGroups?.flat()).toContain("subagent-2: ok");
  });

  it("keeps the character eval scenario natural and task-shaped", () => {
    const characterConfig = readQaScenarioExecutionConfig("character-vibes-gollum") as
      | {
          workspaceFiles?: Record<string, string>;
          turns?: Array<{ text?: string; expectFile?: { path?: string } }>;
        }
      | undefined;

    const turnTexts = characterConfig?.turns?.map((turn) => turn.text ?? "") ?? [];

    expect(characterConfig?.workspaceFiles?.["SOUL.md"]).toContain("# This is your character");
    expect(turnTexts.join("\n")).toContain("precious-status.html");
    expect(turnTexts.join("\n")).not.toContain("How would you react");
    expect(turnTexts.join("\n")).not.toContain("character check");
    expect(
      characterConfig?.turns?.some((turn) => turn.expectFile?.path === "precious-status.html"),
    ).toBe(true);
  });
});

// Regression coverage for openclaw/openclaw#64522: production builds ship
// without the `qa/` directory, so any top-level code path that reads QA
// scenario config must degrade gracefully rather than crash the CLI at
// startup. We fake the absent state by stubbing `fs.existsSync` so the
// internal `resolveRepoPath` walk-up cannot find the scenario pack.
describe("qa scenario catalog when the pack is not shipped", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the pack as available in the dev repo (sanity check)", () => {
    expect(isQaScenarioPackAvailable()).toBe(true);
  });

  it("isQaScenarioPackAvailable returns false when the pack file cannot be resolved", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(isQaScenarioPackAvailable()).toBe(false);
  });

  it("readQaScenarioExecutionConfig returns undefined instead of throwing", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(() =>
      readQaScenarioExecutionConfig("source-docs-discovery-report"),
    ).not.toThrow();
    expect(readQaScenarioExecutionConfig("source-docs-discovery-report")).toBeUndefined();
  });

  it("discovery-eval imports successfully when the pack is absent", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // discovery-eval.ts runs readQaScenarioExecutionConfig at module load via
    // a top-level const. Re-importing it under the stubbed fs proves the
    // CLI startup path no longer crashes in production builds. The module
    // should expose its exported helpers and the hardcoded fallback refs
    // should be in effect.
    vi.resetModules();
    const discoveryEval = await import("./discovery-eval.js");
    expect(typeof discoveryEval.reportsMissingDiscoveryFiles).toBe("function");
    expect(discoveryEval.reportsMissingDiscoveryFiles("blocked by missing files")).toBe(true);
  });
});
