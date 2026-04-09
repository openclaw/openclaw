import { describe, expect, it } from "vitest";
import {
  buildReplyBoundaryGuardConformanceContract,
  getReplyBoundaryGuardConsumedContractMetadata,
  REPLY_BOUNDARY_GUARD_CONSUMER,
  runReplyBoundaryGuardConformanceSuite,
} from "./conformance.ts";
import { applyReplyBoundaryGuard } from "./policy.ts";

describe("reply-boundary-guard conformance", () => {
  it("publishes the consumed Moonlight contract metadata explicitly", () => {
    const metadata = getReplyBoundaryGuardConsumedContractMetadata();

    expect(REPLY_BOUNDARY_GUARD_CONSUMER).toBe("reply-boundary-guard");
    expect(metadata.contractVersion).toBe(1);
    expect(metadata.supportedContractVersions).toEqual([1]);
    expect(metadata.changeTaxonomy.map((entry) => entry.kind)).toEqual([
      "breaking",
      "additive",
      "internal_only",
    ]);
  });

  it("passes the shared reply-boundary conformance suite through the consumer bridge", () => {
    const contract = buildReplyBoundaryGuardConformanceContract();
    const report = runReplyBoundaryGuardConformanceSuite();

    expect(contract.contractVersion).toBe(1);
    expect(contract.supportedContractVersions).toEqual([1]);
    expect(report.contractVersion).toBe(1);
    expect(report.failedChecks).toBe(0);
    expect(report.passedChecks).toBe(report.totalChecks);
    expect(report.failures).toEqual([]);
  });

  it("supplements bare auto-report-back promises with an explicit non-watcher disclaimer", () => {
    const result = applyReplyBoundaryGuard("I'll report back after I check it.");

    expect(result.outputChanged).toBe(true);
    expect(result.usedReportBackSupplement).toBe(true);
    expect(result.outputText).toContain(
      "I will not automatically report back after this reply unless I explicitly set up a real reminder or watcher and tell you that I did.",
    );
  });
});
