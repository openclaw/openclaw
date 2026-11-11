import fs from "node:fs/promises";
import path from "node:path";
import { isStringArray } from "openclaw/plugin-sdk/collection-input-runtime";
import type { QaTestFileScenario } from "./scenario-catalog.js";
import { readJsonFileIfExists } from "./test-file-scenario-script-evidence.js";

type NativeTestFileScenario = Pick<QaTestFileScenario, "id" | "execution">;

export function resolveNativeVitestReportPath(
  scenario: Pick<NativeTestFileScenario, "id">,
  outputDir: string,
): string {
  return path.join(outputDir, `${scenario.id}.vitest-report.json`);
}

export async function readNativeVitestExecutionFailure(params: {
  outputDir: string;
  repoRoot: string;
  scenario: NativeTestFileScenario;
}): Promise<string | undefined> {
  const reportPath = resolveNativeVitestReportPath(params.scenario, params.outputDir);
  const report = await readJsonFileIfExists(reportPath);
  if (!report || typeof report !== "object") {
    return `Vitest exited successfully without writing a valid JSON test report at ${reportPath}.`;
  }
  const { numFailedTests, numPassedTests, success, testResults } = report as {
    numFailedTests?: unknown;
    numPassedTests?: unknown;
    success?: unknown;
    testResults?: Array<{
      name?: unknown;
      assertionResults?: Array<{ ancestorTitles?: unknown; status?: unknown; title?: unknown }>;
    }>;
  };
  if (
    success !== true ||
    typeof numPassedTests !== "number" ||
    !Number.isSafeInteger(numPassedTests) ||
    numPassedTests < 1 ||
    numFailedTests !== 0
  ) {
    return "Vitest exited successfully without reporting a successfully executed test.";
  }
  const expectedTestPath = await fs
    .realpath(path.resolve(params.repoRoot, params.scenario.execution.path))
    .catch(() => undefined);
  if (!expectedTestPath) {
    return `Vitest exited successfully without an existing requested test file ${params.scenario.execution.path}.`;
  }
  const canonicalRepoRoot = await fs.realpath(params.repoRoot);
  const matchingTestResult = (
    await Promise.all(
      (Array.isArray(testResults) ? testResults : []).map(async (result) => {
        if (!result || typeof result.name !== "string") {
          return undefined;
        }
        const absoluteTestPath = path.resolve(params.repoRoot, result.name);
        let reportedTestPath = await fs.realpath(absoluteTestPath).catch(() => undefined);
        if (!reportedTestPath) {
          const repoRelativePath = path.relative(params.repoRoot, absoluteTestPath);
          reportedTestPath =
            repoRelativePath !== ".." &&
            !repoRelativePath.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(repoRelativePath)
              ? path.resolve(canonicalRepoRoot, repoRelativePath)
              : absoluteTestPath;
        }
        return reportedTestPath === expectedTestPath ? result : undefined;
      }),
    )
  ).find((result) => result !== undefined);
  const passedAssertions = Array.isArray(matchingTestResult?.assertionResults)
    ? matchingTestResult.assertionResults.filter((assertion) => assertion.status === "passed")
    : [];
  if (passedAssertions.length === 0) {
    return `Vitest exited successfully without a passed assertion for the requested test file ${params.scenario.execution.path}.`;
  }
  const testNamePattern =
    params.scenario.execution.kind === "playwright"
      ? params.scenario.execution.testNamePattern
      : undefined;
  if (testNamePattern) {
    let requestedTestName: RegExp;
    try {
      // Vitest resolves string --testNamePattern values with the same RegExp constructor.
      requestedTestName = new RegExp(testNamePattern);
    } catch {
      return `Vitest exited successfully with an invalid requested test name pattern ${JSON.stringify(testNamePattern)}.`;
    }
    if (
      !passedAssertions.some((assertion) => {
        // Native JSON fullName uses spaces; v5 selection joins the title chain with >.
        return (
          typeof assertion.title === "string" &&
          isStringArray(assertion.ancestorTitles) &&
          requestedTestName.test([...assertion.ancestorTitles, assertion.title].join(" > "))
        );
      })
    ) {
      return `Vitest exited successfully without a passed assertion for the requested test name pattern ${JSON.stringify(testNamePattern)}.`;
    }
  }
  return undefined;
}
