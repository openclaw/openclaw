// Qa Lab tests cover self check plugin behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { QaSelfCheckResult } from "./self-check.js";
import { isQaSelfCheckSuccessful, resolveQaSelfCheckOutputPath } from "./self-check.js";

function makeSelfCheckResult(params: {
  scenarioStatus: "pass" | "fail";
  checkStatuses: Array<"pass" | "fail">;
}): QaSelfCheckResult {
  return {
    outputPath: "/tmp/qa-self-check.md",
    report: "",
    checks: params.checkStatuses.map((status, index) => ({
      name: `check ${String(index + 1)}`,
      status,
    })),
    scenarioResult: {
      name: "QA self-check scenario",
      status: params.scenarioStatus,
      steps: [],
    },
  };
}

describe("isQaSelfCheckSuccessful", () => {
  it("requires the scenario and every check to pass", () => {
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "pass", checkStatuses: ["pass"] }),
      ),
    ).toBe(true);
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "fail", checkStatuses: ["pass"] }),
      ),
    ).toBe(false);
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "pass", checkStatuses: ["pass", "fail"] }),
      ),
    ).toBe(false);
  });
});

describe("resolveQaSelfCheckOutputPath", () => {
  it("keeps explicit output paths untouched", () => {
    expect(
      resolveQaSelfCheckOutputPath({
        repoRoot: "/tmp/openclaw-repo",
        outputPath: "/tmp/custom/self-check.md",
      }),
    ).toBe("/tmp/custom/self-check.md");
  });

  it("anchors default self-check reports under unique files in the provided repo root", () => {
    const repoRoot = path.resolve("/tmp/openclaw-repo");
    const firstPath = resolveQaSelfCheckOutputPath({ repoRoot });
    const secondPath = resolveQaSelfCheckOutputPath({ repoRoot });

    expect(path.dirname(firstPath)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(firstPath)).toMatch(/^self-check-[a-z0-9]+-[a-f0-9]{8}\.md$/u);
    expect(secondPath).not.toBe(firstPath);
  });
});
