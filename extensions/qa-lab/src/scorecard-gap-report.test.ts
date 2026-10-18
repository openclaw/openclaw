import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  validateQaEvidenceSummaryJson,
  type QaEvidenceIdentity,
  type QaEvidenceStatus,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { readQaScenarioById, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  buildQaScorecardGapReport,
  renderQaScorecardGapMarkdownReport,
} from "./scorecard-gap-report.js";
import {
  qaMaturityTaxonomyIdentity,
  readQaMaturityTaxonomySource,
  type QaProofRequirements,
} from "./scorecard-taxonomy.js";

const identity: QaEvidenceIdentity = {
  source: { ref: "fixture-source", integrity: "fixture-integrity" },
  runtime: { id: "node", version: "fixture-version" },
  package: null,
  protocol: null,
  accountRef: null,
  proofClass: "fixture-only",
};

function fixture(
  retryAcceptance: QaProofRequirements[number]["retryAcceptance"] = "selected-attempt",
) {
  const taxonomy = readQaMaturityTaxonomySource(
    path.resolve(import.meta.dirname, "../../../taxonomy.yaml"),
  );
  const surface = taxonomy.surfaces.find((item) => !item.archived)!;
  taxonomy.surfaces = [
    {
      ...surface,
      categories: [
        {
          ...surface.categories[0]!,
          features: ["channels.dm", "channels.secondary", "channels.unmapped"].map((id) => ({
            name: id,
            coverageIds: [id],
          })),
        },
      ],
    },
  ];
  const requirements: QaProofRequirements = [
    {
      id: "declared-proof",
      coverageId: "channels.dm",
      obligation: "required",
      owner: "fixture-owner",
      acceptedRef: "qa/fixture",
      retryAcceptance,
      alternatives: [{ runtime: "node", sourceRef: "fixture-source", proofClass: "fixture-only" }],
    },
  ];
  taxonomy.profiles = [
    { ...taxonomy.profiles.find((item) => item.id === "all")!, proofRequirements: requirements },
  ];
  const scenario: QaSeedScenarioWithSource = {
    ...readQaScenarioById("thread-isolation"),
    coverage: { primary: ["channels.dm"], secondary: ["channels.secondary"] },
    assertions: ["first", "second"].map((id) => ({
      id,
      meaning: `Fixture ${id}`,
      coverage: [{ id: "channels.dm", role: "primary" }],
    })),
  };
  const plan = () =>
    qaProfileEvidencePlan.build({
      profile: "all",
      taxonomyIdentity: qaMaturityTaxonomyIdentity(taxonomy),
      proofRequirements: taxonomy.profiles[0]!.proofRequirements,
      membershipScenarios: [scenario],
      selectedScenarios: [scenario],
      excludedScenarios: [],
      expectedCells: [
        { scenarioId: scenario.id, executionKind: scenario.execution.kind, channel: null },
      ],
      observedCells: [
        { scenarioId: scenario.id, executionKind: scenario.execution.kind, channel: null },
      ],
    });
  const owner = createQaEvidenceInvocation({
    scenarios: [scenario],
    channel: null,
    launch: identity,
  });
  function complete(
    statuses: Partial<Record<"first" | "second", QaEvidenceStatus>>,
    terminalStatus: QaEvidenceStatus = "pass",
  ) {
    const id = owner.begin(0);
    owner.complete(id, {
      status: terminalStatus,
      entries: Object.entries(statuses).map(([assertionId, status]) => ({
        test: { id: scenario.id, title: "Fixture", kind: "flow" },
        coverage: [{ id: "channels.dm", role: "primary" }],
        binding: { occurrenceId: id, assertionId, receiptId: "receipt" },
        effective: true,
        result: { status },
      })),
      receipts: [
        {
          id: "receipt",
          phase: "runtime",
          identity,
          artifact: {
            kind: "fixture",
            path: "fixture.json",
            source: "qa-suite",
            sha256: "a".repeat(64),
          },
        },
      ],
    });
    owner.select(0, id);
    return id;
  }
  const evidence = (evidenceMode: "full" | "slim" = "full") => ({
    ...owner.snapshot({ generatedAt: "2026-10-01T00:00:00Z", profile: "all", evidenceMode }),
    profilePlan: plan(),
  });
  const report = (evidenceMode: "full" | "slim" = "full") =>
    buildQaScorecardGapReport({
      taxonomy,
      scenarios: [scenario],
      evidence: evidence(evidenceMode),
    });
  return { taxonomy, scenario, owner, complete, evidence, report, plan };
}

describe("scorecard gap report", () => {
  it.each(["full", "slim"] as const)(
    "requires one complete terminal passing attempt in %s evidence",
    (mode) => {
      const f = fixture();
      const failed = f.complete({ first: "pass", second: "pass" }, "fail");
      const before = f.evidence(mode);
      const bytes = JSON.stringify(before);
      const taxonomyBytes = JSON.stringify(f.taxonomy);
      // Existing enforcement semantics are intentional; the stricter report is local.
      expect(qaProfileEvidencePlan.evaluateProof(f.plan(), before)[0]?.qualified).toBe(true);
      const failedReport = buildQaScorecardGapReport({
        taxonomy: f.taxonomy,
        scenarios: [f.scenario],
        evidence: before,
      });
      expect(
        failedReport.coverage.find((row) => row.coverageId === "channels.dm")?.qualification,
      ).toBe("gap");
      expect(failedReport.attempts).toEqual([
        expect.objectContaining({ occurrenceId: failed, terminalStatus: "fail", complete: false }),
      ]);
      expect(JSON.stringify(before)).toBe(bytes);

      const selected = f.complete({ first: "pass", second: "pass" });
      const passed = f.report(mode);
      expect(passed.coverage.find((row) => row.coverageId === "channels.dm")?.qualification).toBe(
        "qualified",
      );
      expect(passed.declarations[0]?.checks.every((check) => check.occurrenceId === selected)).toBe(
        true,
      );
      expect(passed.attempts.find((item) => item.occurrenceId === failed)?.effective).toBe(false);
      expect(passed.unmatchedObservations).toEqual([
        expect.objectContaining({
          binding: expect.objectContaining({ occurrenceId: failed }),
          recordedEffective: false,
          effective: false,
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ occurrenceId: failed }),
          recordedEffective: false,
          effective: false,
        }),
      ]);
      expect(JSON.stringify(f.taxonomy)).toBe(taxonomyBytes);
    },
  );

  it.each(["id", "meaning", "coverage-id", "coverage-role", "added-assertion"] as const)(
    "does not qualify captured proof after current assertion %s drift",
    (kind) => {
      const f = fixture();
      f.complete({ first: "pass", second: "pass" });
      const evidence = f.evidence();
      const before = JSON.stringify(evidence);
      const current = structuredClone(f.scenario);
      const assertion = current.assertions![0]!;
      if (kind === "id") {
        assertion.id = "replacement";
      } else if (kind === "meaning") {
        assertion.meaning = "A different required behavior";
      } else if (kind === "coverage-id") {
        assertion.coverage[0]!.id = "channels.secondary";
      } else if (kind === "coverage-role") {
        assertion.coverage[0]!.role = "secondary";
      } else {
        current.assertions!.push({ ...assertion, id: "third" });
      }
      expect(qaProfileEvidencePlan.evaluateProof(f.plan(), evidence)[0]?.qualified).toBe(true);
      const report = buildQaScorecardGapReport({
        taxonomy: f.taxonomy,
        scenarios: [current],
        evidence,
      });
      expect(report.coverage[0]?.qualification).toBe("gap");
      expect(report.attempts[0]).toMatchObject({ declarationStatus: "stale", complete: false });
      expect(renderQaScorecardGapMarkdownReport(report)).toContain("stale-declaration");
      expect(JSON.stringify(evidence)).toBe(before);
    },
  );

  it.each([
    "scenario",
    "current-assertions",
    "current-empty",
    "captured-assertions",
    "captured-empty",
  ] as const)("keeps missing %s attribution UNKNOWN", (kind) => {
    const f = fixture();
    const id = f.complete({ first: "pass", second: "pass" });
    const evidence = f.evidence();
    const current = structuredClone(f.scenario);
    if (kind === "scenario") {
      current.id = "different-scenario";
    } else if (kind === "current-assertions") {
      delete current.assertions;
    } else if (kind === "current-empty") {
      current.assertions = [];
    } else {
      evidence.occurrences.find((item) => item.id === id)!.assertions =
        kind === "captured-empty" ? [] : null;
      for (const entry of evidence.entries) {
        entry.binding.assertionId = null;
      }
    }
    const report = buildQaScorecardGapReport({
      taxonomy: f.taxonomy,
      scenarios: [current],
      evidence: validateQaEvidenceSummaryJson(evidence),
    });
    expect(report.attempts[0]).toMatchObject({ declarationStatus: "unknown", complete: false });
    expect(report.coverage[0]?.qualification).toBe("unknown");
  });

  it("compares declarations independently of assertion and coverage ordering", () => {
    const f = fixture();
    const id = f.complete({ first: "pass", second: "pass" });
    const evidence = f.evidence();
    const captured = evidence.occurrences.find((item) => item.id === id)!;
    const current = structuredClone(f.scenario);
    current.assertions![0]!.coverage.push({ id: "channels.secondary", role: "secondary" });
    captured.assertions = structuredClone(current.assertions!);
    current.assertions![0]!.coverage.reverse();
    current.assertions!.reverse();
    const report = buildQaScorecardGapReport({
      taxonomy: f.taxonomy,
      scenarios: [current],
      evidence,
    });
    expect(report.attempts[0]).toMatchObject({ declarationStatus: "current", complete: true });
    expect(report.coverage[0]?.qualification).toBe("qualified");
  });

  it.each(["selected-attempt", "all-recorded-attempts"] as const)(
    "applies declaration freshness to the evaluator's %s context",
    (policy) => {
      const f = fixture(policy);
      const old = f.complete({ first: "pass", second: "pass" }, "fail");
      f.complete({ first: "pass", second: "pass" });
      const evidence = f.evidence();
      evidence.occurrences.find((item) => item.id === old)!.assertions![0]!.meaning =
        "Historical assertion meaning";
      const report = buildQaScorecardGapReport({
        taxonomy: f.taxonomy,
        scenarios: [f.scenario],
        evidence: validateQaEvidenceSummaryJson(evidence),
      });
      expect(report.coverage[0]?.qualification).toBe(
        policy === "selected-attempt" ? "qualified" : "gap",
      );
      expect(report.attempts.find((item) => item.occurrenceId === old)?.declarationStatus).toBe(
        "stale",
      );
    },
  );

  it.each(["selected-attempt", "all-recorded-attempts"] as const)(
    "retains only relevant unknown assertion history under %s",
    (policy) => {
      for (const mapping of ["primary", "secondary", "unrelated"] as const) {
        const f = fixture(policy);
        const old = f.complete({ first: "pass", second: "pass" }, "fail");
        f.complete({ first: "pass", second: "pass" });
        const evidence = f.evidence();
        evidence.occurrences.find((item) => item.id === old)!.assertions = null;
        for (const entry of evidence.entries.filter((item) => item.binding.occurrenceId === old)) {
          entry.binding.assertionId = null;
          entry.coverage = [
            {
              id: mapping === "unrelated" ? "channels.secondary" : "channels.dm",
              role: mapping === "secondary" ? "secondary" : "primary",
            },
          ];
        }
        const report = buildQaScorecardGapReport({
          taxonomy: f.taxonomy,
          scenarios: [f.scenario],
          evidence: validateQaEvidenceSummaryJson(evidence),
        });
        expect(report.coverage[0]?.qualification, `${policy}/${mapping}`).toBe(
          policy === "all-recorded-attempts" && mapping === "primary" ? "unknown" : "qualified",
        );
        expect(report.attempts.find((item) => item.occurrenceId === old)?.declarationStatus).toBe(
          "unknown",
        );
      }
    },
  );

  it("does not combine incomplete retries or hide failures under all-recorded policy", () => {
    const f = fixture();
    f.complete({ first: "pass" }, "fail");
    f.complete({ second: "pass" });
    expect(f.report().coverage[0]?.qualification).toBe("gap");
    const all = fixture("all-recorded-attempts");
    all.complete({ first: "fail", second: "pass" }, "fail");
    all.complete({ first: "pass", second: "pass" });
    expect(all.report().declarations[0]).toMatchObject({
      qualification: "gap",
      checks: expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
    });
  });

  it("requires every captured assertion even when another coverage ID owns it", () => {
    const f = fixture();
    f.scenario.assertions![1]!.coverage = [{ id: "channels.secondary", role: "primary" }];
    const id = f.complete({ first: "pass" });
    const updated = f.evidence();
    updated.occurrences.find((item) => item.id === id)!.assertions = f.scenario.assertions!;
    expect(qaProfileEvidencePlan.evaluateProof(f.plan(), updated)[0]?.qualified).toBe(true);
    expect(
      buildQaScorecardGapReport({
        taxonomy: f.taxonomy,
        scenarios: [f.scenario],
        evidence: updated,
      }).coverage[0]?.qualification,
    ).toBe("gap");
  });

  it.each(["absent", "empty", "advisory"] as const)(
    "leaves %s requirements UNKNOWN without changing passing observations",
    (kind) => {
      const f = fixture();
      if (kind === "absent") {
        delete f.taxonomy.profiles[0]!.proofRequirements;
      } else if (kind === "empty") {
        f.taxonomy.profiles[0]!.proofRequirements = [];
      } else {
        f.taxonomy.profiles[0]!.proofRequirements![0]!.obligation = "advisory";
      }
      f.complete({ first: "pass", second: "pass" });
      expect(f.report().coverage[0]).toMatchObject({
        qualification: "unknown",
        observed: [
          expect.objectContaining({ status: "pass" }),
          expect.objectContaining({ status: "pass" }),
        ],
      });
      if (kind === "advisory") {
        expect(f.report().declarations[0]?.qualification).toBe("qualified");
      }
    },
  );

  it("keeps unmapped, secondary-only, excluded and unstarted catalog facts distinct", () => {
    const f = fixture();
    const evidence = f.evidence();
    evidence.profilePlan = qaProfileEvidencePlan.build({
      profile: "all",
      taxonomyIdentity: qaMaturityTaxonomyIdentity(f.taxonomy),
      membershipScenarios: [f.scenario],
      selectedScenarios: [],
      excludedScenarios: [{ scenario: f.scenario, reasons: ["fixture prerequisite absent"] }],
      expectedCells: [],
      observedCells: [],
    });
    const report = buildQaScorecardGapReport({
      taxonomy: f.taxonomy,
      scenarios: [f.scenario],
      evidence,
    });
    expect(report.coverage).toEqual([
      expect.objectContaining({
        coverageId: "channels.dm",
        catalogStatus: "primary",
        observed: [],
        catalog: [
          expect.objectContaining({
            selected: false,
            excludedReasons: ["fixture prerequisite absent"],
            outcomes: [expect.objectContaining({ status: null })],
          }),
        ],
      }),
      expect.objectContaining({
        coverageId: "channels.secondary",
        catalogStatus: "secondary-only",
      }),
      expect.objectContaining({
        coverageId: "channels.unmapped",
        catalogStatus: "unmapped",
        catalog: [],
      }),
    ]);
  });

  it.each(["missing", "stale", "legacy"] as const)(
    "preserves %s attribution as UNKNOWN",
    (kind) => {
      const f = fixture();
      f.complete({ first: "pass", second: "pass" });
      const evidence = f.evidence();
      if (kind === "missing") {
        delete evidence.profilePlan.taxonomyIdentity;
      } else if (kind === "stale") {
        evidence.profilePlan.taxonomyIdentity = { version: 1, sha256: "0".repeat(64) };
      }
      const input =
        kind === "legacy"
          ? validateQaEvidenceSummaryJson({
              kind: evidence.kind,
              schemaVersion: 2,
              generatedAt: evidence.generatedAt,
              evidenceMode: evidence.evidenceMode,
              profile: evidence.profile,
              profilePlan: evidence.profilePlan,
              entries: evidence.entries.map(
                ({ binding: _binding, effective: _effective, ...row }) => row,
              ),
            })
          : evidence;
      const report = buildQaScorecardGapReport({
        taxonomy: f.taxonomy,
        scenarios: [f.scenario],
        evidence: input,
      });
      expect(report.coverage[0]?.qualification).toBe("unknown");
      expect(report.coverage[0]?.observed).toHaveLength(2);
      if (kind === "legacy") {
        expect(report.attempts).toEqual([]);
        expect(report.coverage[0]?.observed.every((row) => row.occurrenceId === null)).toBe(true);
      }
    },
  );

  it.each(["primary", "secondary"] as const)(
    "honors enclosing %s caps and terminal outcomes",
    (role) => {
      const f = fixture();
      f.complete({ first: "pass", second: "pass" });
      const parent = createQaEvidenceInvocation({
        scenarios: [{ id: "outer", execution: { kind: "script" } }],
        channel: null,
        launch: identity,
      });
      const id = parent.begin(0);
      parent.complete(id, {
        status: "fail",
        childEvidence: f.evidence(),
        childCoverage: [{ id: "channels.dm", role }],
        entries: [
          {
            test: { kind: "script", id: "outer", title: "outer" },
            coverage: [],
            result: { status: "fail" },
          },
        ],
        receipts: [
          {
            id: "bundle",
            phase: "prepared",
            identity,
            artifact: {
              kind: "producer-evidence",
              source: "script",
              path: "qa-evidence.json",
              sha256: "b".repeat(64),
            },
          },
        ],
      });
      parent.select(0, id);
      const evidence = {
        ...parent.snapshot({ generatedAt: "2026-10-01T00:00:00Z", profile: "all" }),
        profilePlan: f.plan(),
      };
      const evidenceBytes = JSON.stringify(evidence);
      const report = buildQaScorecardGapReport({
        taxonomy: f.taxonomy,
        scenarios: [f.scenario],
        evidence,
      });
      expect(report.coverage[0]?.qualification).toBe("gap");
      expect(report.coverage[0]?.observed.map((row) => row.role)).toEqual([role, role]);
      expect(
        report.attempts.filter((item) => item.enclosing.length > 0).every((item) => !item.complete),
      ).toBe(true);
      expect(JSON.stringify(evidence)).toBe(evidenceBytes);
    },
  );

  it("retains unmatched v2 observations without using them to qualify current coverage", () => {
    const f = fixture();
    const evidence = validateQaEvidenceSummaryJson({
      kind: f.evidence().kind,
      schemaVersion: 2,
      generatedAt: "2026-10-01T00:00:00Z",
      evidenceMode: "full",
      profile: "all",
      entries: [
        {
          test: { id: "unmapped", title: "Unmapped diagnostic", kind: "script" },
          coverage: [],
          result: { status: "blocked" },
        },
        {
          test: { id: "retired", title: "Retired observation", kind: "script" },
          coverage: [{ id: "channels.retired", role: "primary" }],
          result: { status: "fail" },
        },
      ],
    });
    const before = JSON.stringify(evidence);
    const report = buildQaScorecardGapReport({
      taxonomy: f.taxonomy,
      scenarios: [f.scenario],
      evidence,
    });
    expect(report.unmatchedObservations).toEqual(
      evidence.entries.map((entry) => ({
        test: entry.test,
        result: entry.result,
        coverage: entry.coverage,
        projectedCoverage: entry.coverage,
        binding: null,
        recordedEffective: null,
        effective: true,
      })),
    );
    expect(
      report.coverage.every((row) => row.observed.length === 0 && row.qualification === "unknown"),
    ).toBe(true);
    const markdown = renderQaScorecardGapMarkdownReport(report);
    expect(markdown).toContain("| unmapped | blocked | none | true |");
    expect(markdown).toContain("| retired | fail | channels.retired (primary) | true |");
    expect(JSON.stringify(evidence)).toBe(before);
  });

  it("renders declaration diagnostics as text without Markdown or MDX injection", () => {
    const f = fixture();
    const report = f.report();
    report.evidence.profile = "<tag>{x}|\nnext";
    const markdown = renderQaScorecardGapMarkdownReport(report);
    expect(markdown).toContain("&lt;tag&gt;&#123;x&#125;&#124; next");
    expect(markdown).toContain("UNKNOWN");
    expect(markdown).toContain("Scores and gates are unchanged");
  });
});
