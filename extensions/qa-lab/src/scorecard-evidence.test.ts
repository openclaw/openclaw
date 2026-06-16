// Qa Lab tests cover profile scorecard evidence behavior.
import { describe, expect, it } from "vitest";
import type { QaEvidenceSummaryJson } from "./evidence-summary.js";
import { buildQaProfileScorecardEvidence } from "./scorecard-evidence.js";
import type { QaScorecardCategoryCoverageReport } from "./scorecard-taxonomy.js";

const category = {
  id: "channel-framework.conversation-routing-and-delivery",
  taxonomySurfaceId: "channel-framework",
  taxonomyCategoryName: "Conversation Routing and Delivery",
  coverageStatus: "partial",
  profiles: ["smoke-ci"],
  coverageIds: ["channels.dm", "channels.group-messages"],
  fulfilledCoverageIds: [],
  evidence: [],
  scenarioRefs: [],
  missingCoverageIds: [],
  missingEvidenceRefs: [],
} satisfies QaScorecardCategoryCoverageReport;

function makeEvidence(status: "pass" | "fail" | "blocked" | "skipped"): QaEvidenceSummaryJson {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-16T00:00:00.000Z",
    evidenceMode: "full",
    entries: [
      {
        test: {
          kind: "qa-scenario",
          id: "dm-chat-baseline",
          title: "DM baseline conversation",
        },
        coverage: [
          {
            id: "channels.dm",
            role: "primary",
          },
          {
            id: "channels.group-messages",
            role: "secondary",
          },
        ],
        result: {
          status,
          ...(status === "pass" ? {} : { failure: { reason: `${status} test` } }),
        },
      },
    ],
  };
}

describe("profile scorecard evidence", () => {
  it("does not fulfill coverage with skipped infrastructure-gap evidence", () => {
    const scorecard = buildQaProfileScorecardEvidence({
      categories: [category],
      evidence: makeEvidence("skipped"),
      featureCoverageByCategoryId: new Map([
        [category.id, [["channels.dm"], ["channels.group-messages"]]],
      ]),
      filters: {},
    });

    expect(scorecard.features).toMatchObject({
      fulfilled: 0,
      missing: 2,
    });
    expect(scorecard.categoryReports[0]).toMatchObject({
      status: "missing",
      missingCoverageIds: ["channels.dm", "channels.group-messages"],
    });
  });

  it("fulfills primary and secondary-only coverage only from passing evidence", () => {
    const scorecard = buildQaProfileScorecardEvidence({
      categories: [category],
      evidence: makeEvidence("pass"),
      featureCoverageByCategoryId: new Map([
        [category.id, [["channels.dm"], ["channels.group-messages"]]],
      ]),
      filters: {},
    });

    expect(scorecard.features).toMatchObject({
      fulfilled: 1,
      missing: 1,
    });
    expect(scorecard.categoryReports[0]?.features).toMatchObject({
      secondaryOnly: 1,
    });
  });
});
