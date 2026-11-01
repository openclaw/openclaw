import { describe, expect, it } from "vitest";
import {
  hasDiscoveryLabels,
  reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles,
} from "./discovery-eval.js";

const refs =
  "repo/qa/scenarios/index.yaml, repo/extensions/qa-lab/src/suite.ts, repo/docs/help/testing.md";
function checkReport(worked: string, failed = "None.", missing = false, leak = false) {
  const report = `Worked\n- ${worked}\nFailed\n- ${failed}\nBlocked\n- Runtime execution not attempted here.\nFollow-up\n- Run the live suite next.`;
  expect(hasDiscoveryLabels(report)).toBe(true);
  expect(reportsMissingDiscoveryFiles(report)).toBe(missing);
  expect(reportsDiscoveryScopeLeak(report)).toBe(leak);
}

describe("qa discovery evaluation", () => {
  it("accepts explicit reads despite quoted file-miss phrases", () => {
    checkReport(
      `Read all three requested files: ${refs}. The helper quotes "not present", "missing files", "blocked by missing", and "could not inspect" as examples.`,
    );
  });

  it("flags genuine file-miss language without confirmed reads", () => {
    checkReport(
      "Read some requested files.",
      "repo/docs/help/testing.md was not present. Could not inspect the remaining refs.",
      true,
    );
  });

  it("flags unrelated suite wrap-up claims", () => {
    checkReport(
      `All three requested files were read: ${refs}. Final QA tally update: all mandatory scenarios resolved. QA run complete.`,
      "None.",
      false,
      true,
    );
  });
});
