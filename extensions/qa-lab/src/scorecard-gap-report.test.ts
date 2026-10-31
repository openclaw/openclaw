import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  validateQaEvidenceSummaryJson,
  type QaEvidenceIdentity,
  type QaEvidenceStatus,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryJson,
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
const readTaxonomy = () =>
  readQaMaturityTaxonomySource(path.resolve(import.meta.dirname, "../../../taxonomy.yaml"));
const passing = { first: "pass", second: "pass" } as const;
const makeEntry = (
  id: string,
  status: QaEvidenceStatus,
  coverage: QaEvidenceSummaryEntry["coverage"] = [],
  kind: "flow" | "script" = "script",
) => ({ test: { id, title: id, kind }, coverage, result: { status } });

function receipt(id: string, phase: "runtime" | "prepared", launch = identity) {
  const runtime = phase === "runtime";
  return {
    id,
    phase,
    identity: launch,
    artifact: {
      kind: runtime ? "fixture" : "producer-evidence",
      source: runtime ? "qa-suite" : "script",
      path: runtime ? "fixture.json" : "qa-evidence.json",
      sha256: (runtime ? "a" : "b").repeat(64),
    },
  };
}

function inspect(params: Parameters<typeof buildQaScorecardGapReport>[0]) {
  const before = JSON.stringify(params);
  const report = buildQaScorecardGapReport(params);
  expect(JSON.stringify(params)).toBe(before);
  return report;
}

function fixture(
  retryAcceptance: QaProofRequirements[number]["retryAcceptance"] = "selected-attempt",
  coverageIds: readonly [string, string, string] = [
    "channels.dm",
    "channels.secondary",
    "channels.unmapped",
  ],
  launch: QaEvidenceIdentity = identity,
) {
  const [primary, secondary] = coverageIds;
  const taxonomy = readTaxonomy();
  const surface = taxonomy.surfaces.find((item) => !item.archived)!;
  const category = {
    ...surface.categories[0]!,
    features: coverageIds.map((id) => ({ name: id, coverageIds: [id] })),
  };
  taxonomy.surfaces = [{ ...surface, categories: [category] }];
  const requirements: QaProofRequirements = [
    {
      id: "declared-proof",
      coverageId: primary,
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
    coverage: { primary: [primary], secondary: [secondary] },
    assertions: ["first", "second"].map((id) => ({
      id,
      meaning: `Fixture ${id}`,
      coverage: [{ id: primary, role: "primary" }],
    })),
  };
  const cells = [
    { scenarioId: scenario.id, executionKind: scenario.execution.kind, channel: null },
  ];
  const plan = () =>
    qaProfileEvidencePlan.build({
      profile: "all",
      taxonomyIdentity: qaMaturityTaxonomyIdentity(taxonomy),
      proofRequirements: taxonomy.profiles[0]!.proofRequirements,
      membershipScenarios: [scenario],
      selectedScenarios: [scenario],
      excludedScenarios: [],
      expectedCells: cells,
      observedCells: cells,
    });
  const owner = createQaEvidenceInvocation({ scenarios: [scenario], channel: null, launch });
  function complete(
    statuses: Partial<Record<"first" | "second", QaEvidenceStatus>> = passing,
    terminalStatus: QaEvidenceStatus = "pass",
  ) {
    const id = owner.begin(0);
    owner.complete(id, {
      status: terminalStatus,
      entries: Object.entries(statuses).map(([assertionId, status]) =>
        Object.assign(makeEntry(scenario.id, status, [{ id: primary, role: "primary" }], "flow"), {
          binding: { occurrenceId: id, assertionId, receiptId: "receipt" },
          effective: true,
        }),
      ),
      receipts: [receipt("receipt", "runtime", launch)],
    });
    owner.select(0, id);
    return id;
  }
  const evidence = (evidenceMode: "full" | "slim" = "full") => ({
    ...owner.snapshot({ generatedAt: "2026-10-01T00:00:00Z", profile: "all", evidenceMode }),
    profilePlan: plan(),
  });
  const reportEvidence = (captured: QaEvidenceSummaryJson, current = scenario) =>
    inspect({ taxonomy, scenarios: [current], evidence: captured });
  const report = (mode: "full" | "slim" = "full") => reportEvidence(evidence(mode));
  return { taxonomy, scenario, complete, evidence, report, reportEvidence, plan };
}

describe("scorecard gap report", () => {
  it.each(["full", "slim"] as const)(
    "keeps unproved regional claims UNKNOWN (%s)",
    (evidenceMode) => {
      const taxonomy = readTaxonomy();
      taxonomy.surfaces = taxonomy.surfaces.filter((surface) => surface.id === "regional-channels");
      const owner = createQaEvidenceInvocation({ scenarios: [], channel: null, launch: identity });
      const evidence = owner.snapshot({
        generatedAt: "2026-10-01T00:00:00Z",
        profile: "all",
        evidenceMode,
      });
      const report = buildQaScorecardGapReport({ taxonomy, scenarios: [], evidence });
      expect(report.coverage).toHaveLength(32);
      for (const row of report.coverage) {
        expect(row).toMatchObject({
          catalogStatus: "unmapped",
          catalog: [],
          observed: [],
          qualification: "unknown",
          requirementIds: [],
        });
      }
      expect(report.declarations).toEqual([]);
      expect(renderQaScorecardGapMarkdownReport(report)).toContain(
        "| regional-channels.dingtalk-enterprise-stream-candidate | unmapped | 0 | UNKNOWN |",
      );
    },
  );

  it.each(["full", "slim"] as const)("isolates regional proof identity (%s)", (mode) => {
    const primary = "regional-channels.wecom-ai-bot-websocket";
    const secondary = "regional-channels.wecom-ai-bot-json-webhook";
    const unrelated = "regional-channels.wecom-enterprise-app-xml-webhook";
    const f = fixture("selected-attempt", [primary, secondary, unrelated], {
      ...identity,
      protocol: "fixture-wecom-bot-websocket",
      accountRef: "fixture-bot-account",
    });
    f.taxonomy.surfaces = readTaxonomy().surfaces.filter(
      (surface) => surface.id === "regional-channels",
    );
    // Synthetic owner declarations exercise existing identity rules, not regional acceptance.
    const requirement = f.taxonomy.profiles[0]!.proofRequirements![0]!;
    requirement.alternatives[0] = {
      ...requirement.alternatives[0],
      protocol: "fixture-wecom-bot-websocket",
      accountRef: "fixture-bot-account",
    };
    f.complete();
    const matched = f.report(mode);
    expect(Object.fromEntries(matched.coverage.map((row) => [row.coverageId, row]))).toMatchObject({
      [primary]: { catalogStatus: "primary", qualification: "qualified" },
      [secondary]: { catalogStatus: "secondary-only", qualification: "unknown", observed: [] },
      [unrelated]: { catalogStatus: "unmapped", qualification: "unknown", observed: [] },
    });
    for (const alternative of [
      { protocol: "fixture-wecom-bot-json-webhook", accountRef: "fixture-bot-account" },
      { protocol: "fixture-wecom-bot-websocket", accountRef: "fixture-other-account" },
    ]) {
      requirement.alternatives[0] = { ...requirement.alternatives[0], ...alternative };
      const mismatched = f.report(mode);
      expect(mismatched.coverage.find((row) => row.coverageId === primary)?.qualification).toBe(
        "gap",
      );
      expect(mismatched.declarations[0]?.checks).toMatchObject([
        { assertionId: "first", status: "stale" },
        { assertionId: "second", status: "stale" },
      ]);
    }
  });

  it.each(["full", "slim"] as const)("requires a complete passing attempt (%s)", (mode) => {
    const f = fixture();
    const failed = f.complete(passing, "fail");
    const before = f.evidence(mode);
    // Existing enforcement semantics are intentional; the stricter report is local.
    expect(qaProfileEvidencePlan.evaluateProof(f.plan(), before)[0]?.qualified).toBe(true);
    const failedReport = f.reportEvidence(before);
    expect(
      failedReport.coverage.find((row) => row.coverageId === "channels.dm")?.qualification,
    ).toBe("gap");
    expect(failedReport.attempts).toMatchObject([
      { occurrenceId: failed, terminalStatus: "fail", complete: false },
    ]);

    const selected = f.complete();
    const passed = f.report(mode);
    expect(passed.coverage.find((row) => row.coverageId === "channels.dm")?.qualification).toBe(
      "qualified",
    );
    expect(passed.declarations[0]?.checks.every((check) => check.occurrenceId === selected)).toBe(
      true,
    );
    expect(passed.attempts.find((item) => item.occurrenceId === failed)?.effective).toBe(false);
    const discarded = expect.objectContaining({
      binding: expect.objectContaining({ occurrenceId: failed }),
      recordedEffective: false,
      effective: false,
    });
    expect(passed.unmatchedObservations).toEqual([discarded, discarded]);
  });

  it.each(["id", "meaning", "coverage-id", "coverage-role", "added-assertion"] as const)(
    "rejects assertion %s drift",
    (kind) => {
      const f = fixture();
      f.complete();
      const evidence = f.evidence();
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
      const report = f.reportEvidence(evidence, current);
      expect(report.coverage[0]?.qualification).toBe("gap");
      expect(report.attempts[0]).toMatchObject({ declarationStatus: "stale", complete: false });
      expect(renderQaScorecardGapMarkdownReport(report)).toContain("stale-declaration");
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
    const id = f.complete();
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
    const report = f.reportEvidence(validateQaEvidenceSummaryJson(evidence), current);
    expect(report.attempts[0]).toMatchObject({ declarationStatus: "unknown", complete: false });
    expect(report.coverage[0]?.qualification).toBe("unknown");
  });

  it("compares declarations independently of assertion and coverage ordering", () => {
    const f = fixture();
    const id = f.complete();
    const evidence = f.evidence();
    const captured = evidence.occurrences.find((item) => item.id === id)!;
    const current = structuredClone(f.scenario);
    current.assertions![0]!.coverage.push({ id: "channels.secondary", role: "secondary" });
    captured.assertions = structuredClone(current.assertions!);
    current.assertions![0]!.coverage.reverse();
    current.assertions!.reverse();
    const report = f.reportEvidence(evidence, current);
    expect(report.attempts[0]).toMatchObject({ declarationStatus: "current", complete: true });
    expect(report.coverage[0]?.qualification).toBe("qualified");
  });

  it.each(["selected-attempt", "all-recorded-attempts"] as const)(
    "checks freshness under %s",
    (policy) => {
      const f = fixture(policy);
      const old = f.complete(passing, "fail");
      f.complete();
      const evidence = f.evidence();
      evidence.occurrences.find((item) => item.id === old)!.assertions![0]!.meaning =
        "Historical assertion meaning";
      const report = f.reportEvidence(validateQaEvidenceSummaryJson(evidence));
      expect(report.coverage[0]?.qualification).toBe(
        policy === "selected-attempt" ? "qualified" : "gap",
      );
      expect(report.attempts.find((item) => item.occurrenceId === old)?.declarationStatus).toBe(
        "stale",
      );
    },
  );

  it.each(["selected-attempt", "all-recorded-attempts"] as const)(
    "retains relevant unknown history under %s",
    (policy) => {
      for (const mapping of ["primary", "secondary", "unrelated"] as const) {
        const f = fixture(policy);
        const old = f.complete(passing, "fail");
        f.complete();
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
        const report = f.reportEvidence(validateQaEvidenceSummaryJson(evidence));
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
    all.complete();
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
    expect(f.reportEvidence(updated).coverage[0]?.qualification).toBe("gap");
  });

  it.each(["absent", "empty", "advisory"] as const)("leaves %s requirements UNKNOWN", (kind) => {
    const f = fixture();
    if (kind === "absent") {
      delete f.taxonomy.profiles[0]!.proofRequirements;
    } else if (kind === "empty") {
      f.taxonomy.profiles[0]!.proofRequirements = [];
    } else {
      f.taxonomy.profiles[0]!.proofRequirements![0]!.obligation = "advisory";
    }
    f.complete();
    expect(f.report().coverage[0]).toMatchObject({
      qualification: "unknown",
      observed: [{ status: "pass" }, { status: "pass" }],
    });
    if (kind === "advisory") {
      expect(f.report().declarations[0]?.qualification).toBe("qualified");
    }
  });

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
    const report = f.reportEvidence(evidence);
    expect(report.coverage).toMatchObject([
      {
        coverageId: "channels.dm",
        catalogStatus: "primary",
        observed: [],
        catalog: [
          {
            selected: false,
            excludedReasons: ["fixture prerequisite absent"],
            outcomes: [{ status: null }],
          },
        ],
      },
      {
        coverageId: "channels.secondary",
        catalogStatus: "secondary-only",
      },
      {
        coverageId: "channels.unmapped",
        catalogStatus: "unmapped",
        catalog: [],
      },
    ]);
  });

  it.each(["missing", "stale", "legacy"] as const)("keeps %s attribution UNKNOWN", (kind) => {
    const f = fixture();
    f.complete();
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
    const report = f.reportEvidence(input);
    expect(report.coverage[0]?.qualification).toBe("unknown");
    expect(report.coverage[0]?.observed).toHaveLength(2);
    if (kind === "legacy") {
      expect(report.attempts).toEqual([]);
      expect(report.coverage[0]?.observed.every((row) => row.occurrenceId === null)).toBe(true);
    }
  });

  it.each(["primary", "secondary"] as const)("honors enclosing %s caps and outcomes", (role) => {
    const f = fixture();
    f.complete();
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
      entries: [makeEntry("outer", "fail")],
      receipts: [receipt("bundle", "prepared")],
    });
    parent.select(0, id);
    const evidence = {
      ...parent.snapshot({ generatedAt: "2026-10-01T00:00:00Z", profile: "all" }),
      profilePlan: f.plan(),
    };
    const report = f.reportEvidence(evidence);
    expect(report.coverage[0]?.qualification).toBe("gap");
    expect(report.coverage[0]?.observed.map((row) => row.role)).toEqual([role, role]);
    expect(
      report.attempts.filter((item) => item.enclosing.length > 0).every((item) => !item.complete),
    ).toBe(true);
  });

  it("retains unmatched v2 observations without using them to qualify current coverage", () => {
    const f = fixture();
    const evidence = validateQaEvidenceSummaryJson({
      kind: f.evidence().kind,
      schemaVersion: 2,
      generatedAt: "2026-10-01T00:00:00Z",
      evidenceMode: "full",
      profile: "all",
      entries: [
        makeEntry("unmapped", "blocked"),
        makeEntry("retired", "fail", [{ id: "channels.retired", role: "primary" }]),
      ],
    });
    const report = f.reportEvidence(evidence);
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
