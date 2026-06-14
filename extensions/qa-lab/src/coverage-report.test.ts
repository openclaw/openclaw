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
  version: 1,
  processVersion: 3,
  snapshotDate: "2026-05-26",
  sourceRef: "origin/main@41eef4a7965",
};

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
    expect(inventory.scorecardTaxonomy.categoryCount).toBe(16);
    expect(inventory.scorecardTaxonomy.ltsIncludedCategoryCount).toBe(7);
    expect(inventory.scorecardTaxonomy.deferredCategoryCount).toBe(8);
    expect(inventory.scorecardTaxonomy.advisoryCategoryCount).toBe(1);
    expect(inventory.scorecardTaxonomy.releaseBlockingCategoryCount).toBe(7);
    expect(inventory.scorecardTaxonomy.mappedCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.mappedScenarioCount).toBeGreaterThan(0);
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
    expect(
      inventory.scorecardTaxonomy.categories.find(
        (category) =>
          category.id === "clawhub-and-external-plugin-distribution.compatibility-and-trust",
      )?.profiles,
    ).toStrictEqual([]);
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
    expect(report).toContain("- Maturity score snapshot: docs/maturity-scores.yaml");
    expect(report).toContain("- Categories: 16 (7 LTS-included, 8 deferred, 1 advisory)");
    expect(report).toContain("- Profiles: 2");
    expect(report).toContain(
      "- smoke-ci: 14 categories; agent-runtime-and-provider-execution.agent-turn-execution,",
    );
    expect(report).toContain(
      "- browser-automation-and-exec-sandbox-tools.tool-invocation-and-execution (browser-automation-and-exec-sandbox-tools / Tool Invocation and Execution; lts-included, release-blocking, mapped): profiles: release, smoke-ci; coverage: tools.apply-patch, tools.exec, tools.fs.read, tools.fs.write, tools.web-search;",
    );
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
      scoreSnapshotRef: "docs/maturity-scores.yaml",
      status: "initial",
      profiles: testScorecardProfiles(),
      categories: [
        {
          id: TEST_EXECUTABLE_CATEGORY_ID,
          taxonomySurfaceId: "agent-runtime-and-provider-execution",
          taxonomyCategoryName: "Agent Turn Execution",
          supportStatus: "lts-included",
          releaseBlocking: true,
          requirement: "Exercise a missing mapping.",
          evidenceRequired: "A real scenario mapping before promotion.",
          evidence: {
            profiles: ["release"],
            liveProofRequired: false,
            freshness: "target-ref",
            coverageIds: ["runtime.missing-coverage"],
            scenarioRefs: ["qa/scenarios/runtime/missing-scorecard-scenario.md"],
            docsRefs: ["docs/missing-scorecard-doc.md"],
            codeRefs: ["src/missing-scorecard-code.ts"],
          },
        },
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
      "scenario-ref-not-found",
      "docs-ref-not-found",
      "code-ref-not-found",
    ]);
  });

  it("reports release-blocking categories missing release profile membership", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      scoreSnapshotRef: "docs/maturity-scores.yaml",
      status: "initial",
      profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "smoke-ci"),
      categories: [
        {
          id: TEST_EXECUTABLE_CATEGORY_ID,
          taxonomySurfaceId: "agent-runtime-and-provider-execution",
          taxonomyCategoryName: "Agent Turn Execution",
          supportStatus: "lts-included",
          releaseBlocking: true,
          requirement: "Release-blocking rows must be selected by the release profile.",
          evidenceRequired: "Release profile membership before promotion.",
          evidence: {
            profiles: ["smoke-ci"],
            liveProofRequired: false,
            freshness: "target-ref",
            coverageIds: ["channels.dm"],
            scenarioRefs: ["qa/scenarios/channels/dm-chat-baseline.md"],
            docsRefs: ["docs/concepts/qa-e2e-automation.md"],
            codeRefs: ["extensions/qa-lab/src/suite.ts"],
          },
        },
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "release-blocking-category-missing-release-profile",
    ]);
  });

  it("reports advisory categories that are accidentally assigned to a runnable profile", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      scoreSnapshotRef: "docs/maturity-scores.yaml",
      status: "initial",
      profiles: testScorecardProfiles(
        "clawhub-and-external-plugin-distribution.compatibility-and-trust",
        "smoke-ci",
      ),
      categories: [
        {
          id: "clawhub-and-external-plugin-distribution.compatibility-and-trust",
          taxonomySurfaceId: "clawhub-and-external-plugin-distribution",
          taxonomyCategoryName: "Compatibility and Trust",
          supportStatus: "advisory",
          releaseBlocking: false,
          requirement: "Keep advisory compatibility out of runnable profiles.",
          evidenceRequired: "Advisory report metadata only.",
          evidence: {
            profiles: [],
            liveProofRequired: false,
            freshness: "latest-advisory-run",
            coverageIds: [],
            scenarioRefs: [],
            docsRefs: ["docs/plugins/architecture.md"],
            codeRefs: [],
          },
        },
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "profile-membership-missing-category-profile",
      "advisory-category-has-profile-membership",
    ]);
  });

  it("reports non-advisory categories with no runnable profile membership", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      scoreSnapshotRef: "docs/maturity-scores.yaml",
      status: "initial",
      profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "none"),
      categories: [
        {
          id: TEST_EXECUTABLE_CATEGORY_ID,
          taxonomySurfaceId: "agent-runtime-and-provider-execution",
          taxonomyCategoryName: "Agent Turn Execution",
          supportStatus: "deferred",
          releaseBlocking: false,
          requirement: "Non-advisory rows must stay visible to runnable profiles.",
          evidenceRequired: "At least one smoke-ci or release membership before promotion.",
          evidence: {
            profiles: [],
            liveProofRequired: false,
            freshness: "target-ref",
            coverageIds: ["channels.dm"],
            scenarioRefs: ["qa/scenarios/channels/dm-chat-baseline.md"],
            docsRefs: ["docs/concepts/qa-e2e-automation.md"],
            codeRefs: ["extensions/qa-lab/src/suite.ts"],
          },
        },
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "non-advisory-category-missing-profile-membership",
    ]);
  });

  it("reports executable category refs missing from taxonomy.yaml", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      scoreSnapshotRef: "docs/maturity-scores.yaml",
      status: "initial",
      profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "release"),
      categories: [
        {
          id: TEST_EXECUTABLE_CATEGORY_ID,
          taxonomySurfaceId: "agent-runtime-and-provider-execution",
          taxonomyCategoryName: "Missing Taxonomy Category",
          supportStatus: "lts-included",
          releaseBlocking: true,
          requirement: "Executable refs must resolve against taxonomy.yaml.",
          evidenceRequired: "A valid taxonomy surface/category ref.",
          evidence: {
            profiles: ["release"],
            liveProofRequired: false,
            freshness: "target-ref",
            coverageIds: ["channels.dm"],
            scenarioRefs: ["qa/scenarios/channels/dm-chat-baseline.md"],
            docsRefs: ["docs/concepts/qa-e2e-automation.md"],
            codeRefs: ["extensions/qa-lab/src/suite.ts"],
          },
        },
      ],
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
      scoreSnapshotRef: "docs/maturity-scores.yaml",
      status: "initial",
      profiles: [
        {
          id: "smoke-ci",
          description: "Test smoke profile.",
          categoryIds: ["missing.category"],
        },
        {
          id: "release",
          description: "Test release profile.",
          categoryIds: [],
        },
      ],
      categories: [
        {
          id: TEST_EXECUTABLE_CATEGORY_ID,
          taxonomySurfaceId: "agent-runtime-and-provider-execution",
          taxonomyCategoryName: "Agent Turn Execution",
          supportStatus: "advisory",
          releaseBlocking: false,
          requirement: "Profile selectors must reference executable category IDs.",
          evidenceRequired: "Invalid selector refs should be reported.",
          evidence: {
            profiles: [],
            liveProofRequired: false,
            freshness: "latest-advisory-run",
            coverageIds: [],
            scenarioRefs: [],
            docsRefs: ["docs/concepts/qa-e2e-automation.md"],
            codeRefs: ["extensions/qa-lab/src/suite.ts"],
          },
        },
      ],
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

  it("reports category profile refs missing from top-level mapping profiles", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      scoreSnapshotRef: "docs/maturity-scores.yaml",
      status: "initial",
      profiles: [...testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "release")],
      categories: [
        {
          id: TEST_EXECUTABLE_CATEGORY_ID,
          taxonomySurfaceId: "agent-runtime-and-provider-execution",
          taxonomyCategoryName: "Agent Turn Execution",
          supportStatus: "lts-included",
          releaseBlocking: true,
          requirement: "Category profile refs must resolve to top-level mapping profiles.",
          evidenceRequired: "Unknown profile refs should be reported.",
          evidence: {
            profiles: ["release", "nightly"],
            liveProofRequired: false,
            freshness: "target-ref",
            coverageIds: ["channels.dm"],
            scenarioRefs: ["qa/scenarios/channels/dm-chat-baseline.md"],
            docsRefs: ["docs/concepts/qa-e2e-automation.md"],
            codeRefs: ["extensions/qa-lab/src/suite.ts"],
          },
        },
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual(["profile-ref-not-found"]);
  });

  it("counts declared custom profiles as runnable category membership", () => {
    const taxonomy = parseQaScorecardTaxonomy({
      version: 1,
      id: "test-taxonomy",
      title: "Test taxonomy",
      taxonomy: TEST_TAXONOMY_REF,
      scoreSnapshotRef: "docs/maturity-scores.yaml",
      status: "initial",
      profiles: [
        ...testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "none"),
        {
          id: "nightly",
          description: "Nightly mapped profile.",
          categoryIds: [TEST_EXECUTABLE_CATEGORY_ID],
        },
      ],
      categories: [
        {
          id: TEST_EXECUTABLE_CATEGORY_ID,
          taxonomySurfaceId: "agent-runtime-and-provider-execution",
          taxonomyCategoryName: "Agent Turn Execution",
          supportStatus: "deferred",
          releaseBlocking: false,
          requirement: "Declared profile names can satisfy runnable coverage.",
          evidenceRequired: "Profile names come from taxonomy-mappings.yaml.",
          evidence: {
            profiles: ["nightly"],
            liveProofRequired: false,
            freshness: "target-ref",
            coverageIds: ["channels.dm"],
            scenarioRefs: ["qa/scenarios/channels/dm-chat-baseline.md"],
            docsRefs: ["docs/concepts/qa-e2e-automation.md"],
            codeRefs: ["extensions/qa-lab/src/suite.ts"],
          },
        },
      ],
    });

    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: readQaScenarioPack().scenarios,
    });

    expect(report.validationIssues).toStrictEqual([]);
  });

  it("rejects taxonomy refs outside the repository", () => {
    expect(() =>
      parseQaScorecardTaxonomy({
        version: 1,
        id: "bad-taxonomy",
        title: "Bad taxonomy",
        taxonomy: {
          ...TEST_TAXONOMY_REF,
          sourcePath: "../rfcs/rfcs/0007-e2e-qa-lab-scorecard-consolidation.md",
        },
        scoreSnapshotRef: "docs/maturity-scores.yaml",
        status: "initial",
        profiles: testScorecardProfiles(TEST_EXECUTABLE_CATEGORY_ID, "smoke-ci"),
        categories: [
          {
            id: TEST_EXECUTABLE_CATEGORY_ID,
            taxonomySurfaceId: "agent-runtime-and-provider-execution",
            taxonomyCategoryName: "Agent Turn Execution",
            supportStatus: "deferred",
            releaseBlocking: false,
            requirement: "Reject escaped refs.",
            evidenceRequired: "Parser rejects refs outside the repository.",
            evidence: {
              profiles: ["smoke-ci"],
              liveProofRequired: false,
              freshness: "target-ref",
              coverageIds: ["runtime.delivery"],
              scenarioRefs: ["qa/scenarios/channels/dm-chat-baseline.md"],
              docsRefs: ["/tmp/outside-openclaw.md"],
              codeRefs: ["src/agents/../agents/agent-tools.ts"],
            },
          },
        ],
      }),
    ).toThrow("repo refs must not be absolute or contain parent-directory segments");
  });
});
