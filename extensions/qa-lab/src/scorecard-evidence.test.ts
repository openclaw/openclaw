import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
  type QaEvidenceSummaryEntry,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan, type QaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { attachQaProfileScorecardEvidenceToFile } from "./scorecard-evidence.js";
import {
  qaMaturityTaxonomyIdentity,
  type QaScorecardCategoryCoverageReport,
} from "./scorecard-taxonomy.js";

function evidenceEntry(
  id: string,
  status: QaEvidenceSummaryEntry["result"]["status"] = "pass",
): QaEvidenceSummaryEntry {
  return {
    test: { kind: "flow", id: "coverage-fixture", title: "Coverage fixture" },
    coverage: [{ id, role: "primary" }],
    refs: [],
    result: { status },
  };
}

function capturedPlan(
  proofRequirements?: Parameters<typeof qaProfileEvidencePlan.build>[0]["proofRequirements"],
) {
  return qaProfileEvidencePlan.build({
    profile: "release",
    taxonomyIdentity: qaMaturityTaxonomyIdentity({
      version: 1,
      title: "Evidence fixture",
      profiles: [],
      levels: [],
      surfaces: [],
    }),
    proofRequirements,
    membershipScenarios: [],
    selectedScenarios: [],
    excludedScenarios: [],
    expectedCells: [],
    observedCells: [],
  });
}

function historicalPlan() {
  const plan = capturedPlan();
  delete plan.taxonomyIdentity;
  return plan;
}

function evidenceSummary(entries: QaEvidenceSummaryEntry[]): QaEvidenceSummaryJson {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-24T00:00:00.000Z",
    evidenceMode: "full",
    entries,
  };
}

function categoryInventory(coverageIds: string[]): QaScorecardCategoryCoverageReport {
  return {
    id: "surface.category",
    taxonomySurfaceId: "surface",
    taxonomyCategoryName: "Category",
    inventoryStatus: "complete",
    profiles: ["release"],
    features: coverageIds.map((coverageId) => ({ name: coverageId, coverageIds: [coverageId] })),
    coverageIds,
    inventoriedCoverageIds: coverageIds,
    inventoryRefs: [],
    scenarioRefs: [],
    missingCoverageIds: [],
    missingInventoryRefs: [],
  };
}

async function buildQaProfileScorecardEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  profilePlan?: QaProfileEvidencePlan;
  evidenceMode?: "full" | "slim";
  categories: readonly QaScorecardCategoryCoverageReport[];
}) {
  return withTempDir("qa-scorecard-evidence-", async (tempRoot) => {
    const evidencePath = path.join(tempRoot, "qa-evidence-summary.json");
    await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence)}\n`, "utf8");
    const scorecard = await attachQaProfileScorecardEvidenceToFile({
      evidencePath,
      profile: "release",
      evidenceMode: params.evidenceMode,
      profilePlan: params.profilePlan ?? historicalPlan(),
      filters: {},
      categories: params.categories,
    });
    const writtenEvidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(evidencePath, "utf8")),
    );
    expect(writtenEvidence.profilePlan?.profile).toBe("release");
    return { scorecard, writtenEvidence };
  });
}

describe("profile scorecard evidence", () => {
  it("applies explicit required proof without rewriting raw passes", async () => {
    const profilePlan = capturedPlan([
      {
        id: "local-protocol",
        coverageId: "coverage.one",
        obligation: "required",
        owner: "fixture-owner",
        acceptedRef: "qa/fixtures/acceptance",
        retryAcceptance: "selected-attempt",
        alternatives: [{ proofClass: "real-plugin/local-protocol" }],
      },
    ]);
    const evidence = evidenceSummary([evidenceEntry("coverage.one")]);
    const { scorecard, writtenEvidence } = await buildQaProfileScorecardEvidence({
      evidence,
      profilePlan,
      categories: [categoryInventory(["coverage.one"])],
    });
    expect(scorecard.coverageIds.fulfilled).toBe(0);
    expect(writtenEvidence.entries).toEqual(evidence.entries);
  });

  it("scores only the selected attempt while retaining raw slim observations and bindings", async () => {
    const evidenceMode = "slim";
    const invocation = createQaEvidenceInvocation({
      scenarios: [{ id: "coverage-fixture", execution: { kind: "script" } }],
      channel: null,
      launch: {
        source: { ref: null, integrity: null },
        runtime: { id: null, version: null },
        package: null,
        protocol: null,
        accountRef: null,
        proofClass: null,
      },
    });
    const first = invocation.begin(0);
    invocation.complete(first, {
      status: "fail",
      entries: [evidenceEntry("coverage.old"), evidenceEntry("coverage.failed", "fail")],
    });
    invocation.select(0, first);
    const retry = invocation.begin(0, first);
    invocation.complete(retry, {
      status: "pass",
      entries: [evidenceEntry("coverage.current")],
    });
    invocation.select(0, retry);
    const evidence = invocation.snapshot({
      generatedAt: "2026-09-13T00:00:00.000Z",
      evidenceMode,
    });
    const { scorecard, writtenEvidence } = await buildQaProfileScorecardEvidence({
      evidence,
      evidenceMode,
      categories: [categoryInventory(["coverage.old", "coverage.failed", "coverage.current"])],
    });
    expect(scorecard.run.evidenceEntryCount).toBe(1);
    expect(scorecard.coverageIds).toEqual({
      total: 3,
      fulfilled: 1,
      missing: 2,
      fulfillmentPercent: 33.3,
    });
    expect(writtenEvidence.schemaVersion).toBe(3);
    expect(writtenEvidence.entries).toEqual(evidence.entries);
    expect(writtenEvidence).toHaveProperty("occurrences", evidence.occurrences);
  });
  it("preserves captured identity in slim evidence without duplicating it in the scorecard", async () => {
    const evidenceMode = "slim";
    const profilePlan = capturedPlan();
    const { writtenEvidence, scorecard } = await buildQaProfileScorecardEvidence({
      evidence: evidenceSummary([evidenceEntry("coverage.one")]),
      evidenceMode,
      profilePlan,
      categories: [categoryInventory(["coverage.one"])],
    });
    expect(writtenEvidence.evidenceMode).toBe(evidenceMode);
    expect(writtenEvidence.profilePlan).toEqual(profilePlan);
    expect(scorecard).not.toHaveProperty("taxonomyIdentity");
    expect(scorecard.coverageIds.fulfilled).toBe(1);
  });
});
