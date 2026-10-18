// QA Lab tests cover profile scorecard evidence math.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  coverage: QaEvidenceSummaryEntry["coverage"],
  status: QaEvidenceSummaryEntry["result"]["status"] = "pass",
  testId = "coverage-fixture",
): QaEvidenceSummaryEntry {
  return {
    test: {
      kind: "flow",
      id: testId,
      title: "Coverage fixture",
    },
    coverage,
    refs: [],
    result: {
      status,
    },
  };
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
  filters: { surface?: string; category?: string };
  categories: readonly QaScorecardCategoryCoverageReport[];
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-scorecard-evidence-"));
  const evidencePath = path.join(tempRoot, "qa-evidence-summary.json");
  await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence)}\n`, "utf8");
  try {
    const scorecard = await attachQaProfileScorecardEvidenceToFile({
      evidencePath,
      profile: "release",
      evidenceMode: params.evidenceMode,
      profilePlan:
        params.profilePlan ??
        ({
          profile: "release",
          membership: [],
          selected: [],
          excluded: [],
          expectedCells: [],
          observedCells: [],
          missingCells: [],
          counts: {
            membership: 0,
            selected: 0,
            excluded: 0,
            expectedCells: 0,
            observedCells: 0,
            missingCells: 0,
          },
        } satisfies QaProfileEvidencePlan),
      filters: params.filters,
      categories: params.categories,
    });
    const writtenEvidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(evidencePath, "utf8")),
    );
    expect(writtenEvidence.profilePlan?.profile).toBe("release");
    return { scorecard, writtenEvidence };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("profile scorecard evidence", () => {
  it.each([{ obligation: "required" as const, fulfilled: 0 }])(
    "applies only explicit $obligation proof obligations without rewriting raw passes",
    async ({ obligation, fulfilled }) => {
      const profilePlan = qaProfileEvidencePlan.build({
        profile: "release",
        taxonomyIdentity: qaMaturityTaxonomyIdentity({
          version: 1,
          title: "Evidence fixture",
          profiles: [],
          levels: [],
          surfaces: [],
        }),
        proofRequirements: [
          {
            id: "local-protocol",
            coverageId: "coverage.one",
            obligation,
            owner: "fixture-owner",
            acceptedRef: "qa/fixtures/acceptance",
            retryAcceptance: "selected-attempt",
            alternatives: [{ proofClass: "real-plugin/local-protocol" }],
          },
        ],
        membershipScenarios: [],
        selectedScenarios: [],
        excludedScenarios: [],
        expectedCells: [],
        observedCells: [],
      });
      const evidence = evidenceSummary([evidenceEntry([{ id: "coverage.one", role: "primary" }])]);
      const { scorecard, writtenEvidence } = await buildQaProfileScorecardEvidence({
        evidence,
        profilePlan,
        filters: {},
        categories: [categoryInventory(["coverage.one"])],
      });
      expect(scorecard.coverageIds.fulfilled).toBe(fulfilled);
      expect(writtenEvidence.entries).toEqual(evidence.entries);
      expect(writtenEvidence.entries[0]?.result.status).toBe("pass");
    },
  );

  it.each(["slim"] as const)(
    "scores only the selected attempt while retaining raw %s observations and bindings",
    async (evidenceMode) => {
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
        entries: [
          evidenceEntry([{ id: "coverage.old", role: "primary" }]),
          evidenceEntry([{ id: "coverage.failed", role: "primary" }], "fail"),
        ],
      });
      invocation.select(0, first);
      const retry = invocation.begin(0, first);
      invocation.complete(retry, {
        status: "pass",
        entries: [evidenceEntry([{ id: "coverage.current", role: "primary" }])],
      });
      invocation.select(0, retry);
      const evidence = invocation.snapshot({
        generatedAt: "2026-09-13T00:00:00.000Z",
        evidenceMode,
      });
      const { scorecard, writtenEvidence } = await buildQaProfileScorecardEvidence({
        evidence,
        evidenceMode,
        filters: {},
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
    },
  );
  it.each(["slim"] as const)(
    "preserves captured identity in %s evidence without duplicating it in the scorecard",
    async (evidenceMode) => {
      const profilePlan = qaProfileEvidencePlan.build({
        profile: "release",
        taxonomyIdentity: qaMaturityTaxonomyIdentity({
          version: 1,
          title: "Evidence fixture",
          profiles: [],
          levels: [],
          surfaces: [],
        }),
        membershipScenarios: [],
        selectedScenarios: [],
        excludedScenarios: [],
        expectedCells: [],
        observedCells: [],
      });
      const { writtenEvidence, scorecard } = await buildQaProfileScorecardEvidence({
        evidence: evidenceSummary([evidenceEntry([{ id: "coverage.one", role: "primary" }])]),
        evidenceMode,
        profilePlan,
        filters: {},
        categories: [categoryInventory(["coverage.one"])],
      });
      expect(writtenEvidence.evidenceMode).toBe(evidenceMode);
      expect(writtenEvidence.profilePlan).toEqual(profilePlan);
      expect(scorecard).not.toHaveProperty("taxonomyIdentity");
      expect(scorecard.coverageIds.fulfilled).toBe(1);
    },
  );
});
