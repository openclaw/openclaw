// Qa Lab tests cover coverage report plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildQaCoverageInventory,
  findQaScenarioMatches,
  renderQaCoverageMarkdownReport,
  renderQaScenarioMatchesMarkdownReport,
} from "./coverage-report.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { buildQaScorecardTaxonomyReport, parseQaScorecardTaxonomy } from "./scorecard-taxonomy.js";

const TEST_EXECUTABLE_CATEGORY_ID = "agent-runtime-and-provider-execution.agent-turn-execution";
const TEST_TAXONOMY_REF = {
  sourcePath: "taxonomy.yaml",
};

function qaScenarioRef(path: string) {
  return { kind: "qa-scenario" as const, path };
}

function vitestRef(path: string) {
  return { kind: "vitest" as const, path };
}

function playwrightRef(path: string) {
  return { kind: "playwright" as const, path };
}

function testScorecardProfiles(categoryId = TEST_EXECUTABLE_CATEGORY_ID, profileId = "release") {
  return [
    {
      id: "smoke-ci",
      description: "Test smoke profile.",
      categoryIds: profileId === "smoke-ci" ? [categoryId] : [],
    },
    {
      id: "release",
      description: "Test release profile.",
      categoryIds: profileId === "release" ? [categoryId] : [],
    },
  ];
}

function testScorecardCategory(params?: {
  taxonomyCategoryName?: string;
  coverageIds?: string[];
  evidenceRefs?: Array<ReturnType<typeof qaScenarioRef | typeof vitestRef | typeof playwrightRef>>;
}) {
  return {
    id: TEST_EXECUTABLE_CATEGORY_ID,
    taxonomySurfaceId: "agent-runtime-and-provider-execution",
    taxonomyCategoryName: params?.taxonomyCategoryName ?? "Agent Turn Execution",
    evidence: {
      coverageIds: params?.coverageIds ?? ["channels.dm"],
      evidenceRefs: params?.evidenceRefs ?? [
        qaScenarioRef("qa/scenarios/channels/dm-chat-baseline.md"),
      ],
    },
  };
}

describe("qa coverage report", () => {
  it("groups scenario coverage metadata by theme and surface", () => {
    const inventory = buildQaCoverageInventory(readQaScenarioPack().scenarios);

    expect(inventory.scenarioCount).toBeGreaterThan(0);
    expect(inventory.coverageIdCount).toBeGreaterThan(0);
    expect(inventory.primaryCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.secondaryCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.overlappingCoverage.length).toBeGreaterThan(0);
    expect(inventory.missingCoverage).toStrictEqual([]);
    expect(inventory.liveTransportLanes.map((lane) => lane.transportId)).toEqual([
      "discord",
      "slack",
      "telegram",
      "whatsapp",
    ]);
    expect(inventory.scorecardTaxonomy.taxonomyId).toBe("stable-lts-initial");
    expect(inventory.scorecardTaxonomy.profileCount).toBe(2);
    expect(inventory.scorecardTaxonomy.categoryCount).toBe(15);
    expect(inventory.scorecardTaxonomy.mappedCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.mappedCoverageIdPercent).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.mappedEvidenceRefCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.unmappedCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.validationIssues).toStrictEqual([]);
    expect(
      inventory.scorecardTaxonomy.profiles
        .find((profile) => profile.id === "release")
        ?.categoryIds.toSorted(),
    ).toEqual([
      "agent-runtime-and-provider-execution.agent-turn-execution",
      "automation-cron-hooks-tasks-polling.cron-jobs",
      "browser-automation-and-exec-sandbox-tools.tool-invocation-and-execution",
      "browser-control-ui-and-webchat.browser-ui",
      "media-understanding-and-media-generation.media-generation",
      "media-understanding-and-media-generation.media-understanding",
      "openai-codex-provider-path.responses-and-tool-compatibility",
      "plugin-sdk-and-bundled-plugin-architecture.installing-and-running-plugins",
      "security-auth-pairing-and-secrets.approval-policy-and-tool-safeguards",
      "security-auth-pairing-and-secrets.credential-and-secret-hygiene",
      "session-memory-and-context-engine.diagnostics-maintenance-and-recovery",
      "session-memory-and-context-engine.memory",
      "session-memory-and-context-engine.token-management",
      "telemetry-diagnostics-and-observability.telemetry-export",
    ]);
    expect(inventory.scenarioPacks.map((pack) => pack.id)).toEqual([
      "observability",
      "personal-agent",
    ]);
    const personalPack = inventory.scenarioPacks.find((pack) => pack.id === "personal-agent");
    const observabilityPack = inventory.scenarioPacks.find((pack) => pack.id === "observability");
    expect(personalPack?.missingScenarioIds).toStrictEqual([]);
    expect(personalPack?.scenarioIds).toContain("personal-share-safe-diagnostics-artifact");
    expect(personalPack?.coverageIds).toContain("personal.redaction");
    expect(personalPack?.coverageIds).toContain("qa.artifact-safety");
    expect(observabilityPack?.missingScenarioIds).toStrictEqual([]);
    expect(observabilityPack?.scenarioIds).toEqual(["otel-trace-smoke", "docker-prometheus-smoke"]);
    expect(observabilityPack?.coverageIds).toContain("telemetry.otel");
    expect(observabilityPack?.coverageIds).toContain("telemetry.prometheus");
    expect(inventory.byTheme.memory.map((feature) => feature.id)).toContain("memory.recall");
    expect(inventory.bySurface.memory.map((feature) => feature.id)).toContain("memory.recall");
  });

  it("renders a compact markdown inventory", () => {
    const report = renderQaCoverageMarkdownReport(
      buildQaCoverageInventory(readQaScenarioPack().scenarios),
    );

    expect(report).toContain("# QA Coverage Inventory");
    expect(report).toContain("- Missing coverage metadata: 0");
    expect(report).toContain("- Overlapping coverage IDs:");
    expect(report).toContain("memory.recall");
    expect(report).toContain("primary: memory-recall (qa/scenarios/memory/memory-recall.md)");
    expect(report).toContain("secondary: active-memory-preprompt-recall");
    expect(report).toContain("## Scenario Packs");
    expect(report).toContain(
      "- personal-agent (Personal Agent Benchmark Pack): 10 scenarios; coverage:",
    );
    expect(report).toContain("- observability (Observability Smoke Pack): 2 scenarios; coverage:");
    expect(report).toContain("otel-trace-smoke, docker-prometheus-smoke");
    expect(report).toContain("personal-share-safe-diagnostics-artifact");
    expect(report).toContain("## Live Transport Lanes");
    expect(report).toContain(
      "- telegram (telegram): canary: always-on, help-command: telegram-help-command, mention-gating: telegram-mention-gating; missing baseline: allowlist-block, top-level-reply-shape, restart-resume",
    );
    expect(report).toContain("thread-follow-up: slack-thread-follow-up");
    expect(report).toContain("## Scorecard Taxonomy");
    expect(report).toContain("- Mapping ID: stable-lts-initial");
    expect(report).toContain("- Maturity taxonomy: taxonomy.yaml");
    expect(report).toContain("- Categories: 15");
    expect(report).toContain("- Profiles: 2");
    expect(report).toContain("- Mapped coverage IDs: 42/145 (29.0%)");
    expect(report).toContain("- Mapped evidence refs:");
    expect(report).toContain(
      "- smoke-ci: 14 categories; agent-runtime-and-provider-execution.agent-turn-execution,",
    );
    expect(report).toContain(
      "- browser-automation-and-exec-sandbox-tools.tool-invocation-and-execution (browser-automation-and-exec-sandbox-tools / Tool Invocation and Execution; mapped): profiles: release, smoke-ci; coverage: tools.apply-patch, tools.exec, tools.fs.read, tools.fs.write, tools.web-search; evidence: qa-scenario:qa/scenarios/runtime/tools/apply-patch.md,",
    );
    expect(report).toContain("playwright:ui/src/ui/e2e/chat-flow.e2e.test.ts");
    expect(report).toContain("### Unmapped Coverage IDs");
    expect(report).toContain("agents.subagents");
  });

  it("renders Playwright matches as qa suite targets", () => {
    const matches = findQaScenarioMatches(readQaScenarioPack().scenarios, "chat-flow.e2e");
    const report = renderQaScenarioMatchesMarkdownReport({
      query: "chat-flow.e2e",
      matches,
    });

    expect(report).toContain(
      "- Suite command: `pnpm openclaw qa suite --scenario control-ui-chat-flow-playwright`",
    );
    expect(report).toContain("  - execution: playwright ui/src/ui/e2e/chat-flow.e2e.test.ts");
  });

  it("splits qa suite targets when matches mix execution kinds", () => {
    const matches = findQaScenarioMatches(readQaScenarioPack().scenarios, "control-ui");
    const report = renderQaScenarioMatchesMarkdownReport({
      query: "control-ui",
      matches,
    });

    expect(report).toContain("- Suite commands:");
    expect(report).toContain("  - flow: `pnpm openclaw qa suite --scenario");
    expect(report).toContain(
      "  - playwright: `pnpm openclaw qa suite --scenario control-ui-chat-flow-playwright`",
    );
  });

  it("reports taxonomy mapping gaps as scorecard signals", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      profiles: testScorecardProfiles(),
      categories: [
        testScorecardCategory({
          coverageIds: ["runtime.missing-coverage"],
          evidenceRefs: [qaScenarioRef("qa/scenarios/runtime/missing-scorecard-scenario.md")],
        }),
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.categories[0]?.mappingStatus).toBe("partial");
    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "coverage-id-not-found",
      "evidence-ref-not-found",
    ]);
  });

  it("reports QA scenario evidence refs that do not cover the category coverage IDs", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      profiles: testScorecardProfiles(),
      categories: [
        testScorecardCategory({
          coverageIds: ["runtime.delivery"],
          evidenceRefs: [qaScenarioRef("qa/scenarios/channels/dm-chat-baseline.md")],
        }),
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "evidence-ref-not-covered-by-category",
    ]);
  });

  it("reports executable category refs missing from taxonomy.yaml", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "release"),
      categories: [testScorecardCategory({ taxonomyCategoryName: "Missing Taxonomy Category" })],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "taxonomy-category-ref-not-found",
    ]);
  });

  it("reports profile membership refs missing from executable categories", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      profiles: [
        {
          id: "smoke-ci",
          description: "Test smoke profile.",
          categoryIds: ["missing.category"],
        },
        {
          id: "release",
          description: "Test release profile.",
          categoryIds: [TEST_EXECUTABLE_CATEGORY_ID],
        },
      ],
      categories: [testScorecardCategory()],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "profile-category-ref-not-found",
    ]);
  });

  it("reports mapped categories with no top-level profile membership", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "none"),
      categories: [testScorecardCategory()],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "mapped-category-missing-profile-membership",
    ]);
  });

  it("reports categories with no profile membership or runnable evidence", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "none"),
      categories: [
        testScorecardCategory({
          coverageIds: [],
          evidenceRefs: [],
        }),
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.categories[0]?.mappingStatus).toBe("missing");
    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "category-without-profile-or-evidence",
    ]);
  });

  it("reports profile-selected categories with incomplete evidence mapping", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "release"),
      categories: [
        testScorecardCategory({
          coverageIds: [],
          evidenceRefs: [qaScenarioRef("qa/scenarios/channels/dm-chat-baseline.md")],
        }),
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.categories[0]?.mappingStatus).toBe("missing");
    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "profile-category-missing-evidence-mapping",
    ]);
  });

  it("derives category profile membership from top-level profiles and accepts typed test refs", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      profiles: [
        ...testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "none"),
        {
          id: "nightly",
          description: "Nightly mapped profile.",
          categoryIds: [TEST_EXECUTABLE_CATEGORY_ID],
        },
      ],
      categories: [
        testScorecardCategory({
          evidenceRefs: [
            vitestRef("extensions/qa-lab/src/coverage-report.test.ts"),
            playwrightRef("ui/src/ui/e2e/chat-flow.e2e.test.ts"),
          ],
        }),
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues).toStrictEqual([]);
    expect(report.categories[0]?.profiles).toStrictEqual(["nightly"]);
    expect(report.categories[0]?.evidenceRefs).toEqual([
      vitestRef("extensions/qa-lab/src/coverage-report.test.ts"),
      playwrightRef("ui/src/ui/e2e/chat-flow.e2e.test.ts"),
    ]);
  });

  it("rejects taxonomy refs outside the repository", () => {
    expect(() =>
      parseQaScorecardTaxonomy({
        version: 1,
        id: "bad-taxonomy",
        title: "Bad taxonomy",
        taxonomy: {
          sourcePath: "../rfcs/rfcs/0007-e2e-qa-lab-scorecard-consolidation.md",
        },
        profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "smoke-ci"),
        categories: [
          testScorecardCategory({
            evidenceRefs: [
              qaScenarioRef("qa/scenarios/channels/dm-chat-baseline.md"),
              playwrightRef("/tmp/outside-openclaw.spec.ts"),
            ],
          }),
        ],
      }),
    ).toThrow("repo refs must not be absolute or contain parent-directory segments");
  });
});
