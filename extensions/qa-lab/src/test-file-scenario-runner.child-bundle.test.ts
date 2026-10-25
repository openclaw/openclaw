import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveQaArtifactPath } from "./cli-paths.js";
import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import {
  buildScriptProducerEvidence,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  QA_TEST_RUNNER_DEFAULTS,
  resolveScriptAttemptOutputDir,
  runQaTestFileScenariosWithCommand as runQaTestFileScenarios,
  writeScriptProducerEvidence,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
afterEach(() => harness.cleanup());

function requireV3(evidence: QaEvidenceSummaryJson): asserts evidence is QaEvidenceSummaryV3Json {
  if (evidence.schemaVersion !== 3) {
    throw new Error("expected occurrence evidence");
  }
}

function continueChildEvidence(evidence?: QaEvidenceSummaryV3Json) {
  return {
    evidenceContinuation: evidence,
    evidenceAnchors:
      evidence &&
      resolveQaEvidenceContainment(evidence.occurrences, evidence.entries).rootInstances,
  };
}

const childCoverage = ["qa.coverage", "qa.reporting", "other.claim"].map((id) => ({
  id,
  role: "primary" as const,
}));
const unresolved = {
  status: "blocked",
  failureMessage: expect.stringContaining("unresolved scheduled scenario"),
};

describe("native attempt child bundles", () => {
  it("retains a later failing producer check and its fallback diagnostic after a blocked retry", async () => {
    const root = await harness.makeTempRepo("qa-native-multicheck-retry-");
    const run = async (continuation?: QaEvidenceSummaryV3Json) =>
      runQaTestFileScenarios({
        repoRoot: root,
        ...QA_TEST_RUNNER_DEFAULTS,
        outputDir: path.join(root, "out"),
        scenarios: [makeTestFileScenario("script", "producer.mjs")],
        ...continueChildEvidence(continuation),
        runCommand: async (command) => {
          await writeScriptProducerEvidence({
            outputDir: resolveScriptAttemptOutputDir(command),
            producerId: "passing-check",
            status: continuation ? "blocked" : "pass",
            additionalEntries: continuation
              ? []
              : buildScriptProducerEvidence({
                  status: "fail",
                  producerId: "failing-check",
                }).entries,
          });
          return { exitCode: 0, stdout: "original command output", stderr: "" };
        },
      });
    const first = await run();
    requireV3(first.evidence);
    expect(first.results[0]?.failureMessage).toBe("failing-check reported failed");
    const originalLog = await fs.readFile(first.results[0]!.logPath);
    const originalRows = structuredClone(first.evidence.entries);
    const second = await run(first.evidence);
    expect(second.results[0]).toMatchObject({
      status: "fail",
      failureMessage: first.results[0]!.failureMessage,
      evidenceOccurrenceId: first.results[0]!.evidenceOccurrenceId,
      logPath: first.results[0]!.logPath,
    });
    expect(second.evidence.entries.slice(0, 2)).toEqual(originalRows);
    expect(await fs.readFile(first.results[0]!.logPath)).toEqual(originalLog);
  });

  it.each(["pass", "blocked", "skipped"] as const)(
    "retains an actual independent v3 subprocess across a %s retry in full and slim projections",
    async (status) => {
      const root = await harness.makeTempRepo("qa-native-child-");
      const script = path.join(root, "producer.mjs");
      const api = pathToFileURL(path.resolve("extensions/qa-lab/src/evidence-invocation.ts")).href;
      await fs.writeFile(
        script,
        `
import fs from "node:fs/promises";
import path from "node:path";
import { createQaEvidenceInvocation } from ${JSON.stringify(api)};
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const status = value("--status");
const output = value("--artifact-base");
const launch = {
  source: { ref: null, integrity: null }, runtime: { id: "node", version: process.version }, package: null,
  protocol: null, accountRef: null, proofClass: null,
};
const scenarios = ["same", "other", "same"].map((id) => ({
  id, execution: { kind: "script" },
}));
const owner = createQaEvidenceInvocation({ scenarios, channel: null, launch });
const results = [status, "pass"];
if (value("--complete") === "true") results.push("pass");
for (const [index, result] of results.entries()) {
  const id = owner.begin(index);
  owner.complete(id, { status: result, entries: index === 0 && value("--omit-first") === "true" ? [] : [{
    test: { id: scenarios[index].id, title: "Actual child check", kind: "script-test" },
    coverage: ${JSON.stringify(childCoverage)},
    result: { status: result },
  }] });
  owner.select(index, id);
}
if (value("--open") === "true") owner.begin(2);
await fs.writeFile(path.join(output, "qa-evidence.json"),
  JSON.stringify(owner.snapshot({ generatedAt: new Date().toISOString() })), { flag: "wx" });
process.exitCode = Number(value("--exit"));
`,
      );
      const run = async (
        nextStatus: string,
        exit: string,
        continuation?: QaEvidenceSummaryV3Json,
        options: {
          completeSchedule?: boolean;
          openUnresolved?: boolean;
          allowBlockedEvidence?: boolean;
          omitFirstRow?: boolean;
        } = {},
      ) => {
        const scenario = makeTestFileScenario("script", script);
        if (scenario.execution.kind !== "script") {
          throw new Error("expected script");
        }
        scenario.execution.args!.push(
          "--status",
          nextStatus,
          "--exit",
          exit,
          "--complete",
          String(options.completeSchedule === true),
          "--open",
          String(options.openUnresolved === true),
          "--omit-first",
          String(options.omitFirstRow === true),
        );
        scenario.execution.allowBlockedEvidence = options.allowBlockedEvidence;
        return runQaTestFileScenarios({
          repoRoot: process.cwd(),
          ...QA_TEST_RUNNER_DEFAULTS,
          outputDir: path.join(root, "out"),
          scenarios: [scenario],
          commandTimeoutMs: 30_000,
          ...continueChildEvidence(continuation),
        });
      };
      const first = await run("fail", "7");
      requireV3(first.evidence);
      const firstId = first.results[0]!.evidenceOccurrenceId!;
      const captured = first.evidence.occurrences.find((item) => item.id === firstId)!;
      const receipt = captured.receipts.find((item) => item.artifact.kind === "producer-evidence")!;
      expect(
        receipt,
        `${first.results[0]?.failureMessage ?? ""}\n${await fs.readFile(first.results[0]!.logPath, "utf8")}`,
      ).toBeDefined();
      const originalPath = resolveQaArtifactPath(
        process.cwd(),
        process.cwd(),
        receipt.artifact.path,
      );
      const originalBytes = await fs.readFile(originalPath);
      expect(receipt.artifact.sha256).toBe(
        createHash("sha256").update(originalBytes).digest("hex"),
      );
      const original = validateQaEvidenceSummaryJson(JSON.parse(originalBytes.toString("utf8")));
      requireV3(original);
      expect(captured.childOccurrenceIds).toEqual(original.occurrences.map((item) => item.id));
      expect(projectQaEvidenceScenarioOutcomes(original).map((item) => item.status)).toEqual([
        "fail",
        "pass",
        null,
      ]);
      expect(new Set(original.occurrences.map((item) => item.id)).size).toBe(5);
      if (status === "pass") {
        for (const openUnresolved of [false, true]) {
          for (const allowBlockedEvidence of [false, true]) {
            const incomplete = await run("pass", "0", undefined, {
              openUnresolved,
              allowBlockedEvidence,
            });
            requireV3(incomplete.evidence);
            expect(incomplete.results[0]).toMatchObject(unresolved);
            expect(projectQaEvidenceScenarioOutcomes(incomplete.evidence)).toMatchObject([
              { status: "blocked" },
            ]);
            expect(
              incomplete.evidence.occurrences.filter(
                (item) =>
                  item.scenario?.kind === "instance" && item.scenario.resultOccurrenceId === null,
              ),
            ).toHaveLength(1);
          }
        }
      } else {
        const terminal = await run(status, "0", undefined, {
          completeSchedule: true,
          omitFirstRow: true,
          allowBlockedEvidence: true,
        });
        // Terminal pointers without effective rows cannot finish the schedule.
        expect(terminal.results[0]).toMatchObject(unresolved);
        expect(
          projectQaEvidenceScenarioOutcomes(terminal.results[0]!.producerEvidence!)[0]?.status,
        ).toBeNull();
        if (status === "blocked") {
          const allowed = await run(status, "0", undefined, {
            completeSchedule: true,
            allowBlockedEvidence: true,
          });
          expect(allowed.results[0]?.status).toBe("pass");
        }
      }
      const second = await run(status, "0", first.evidence, { completeSchedule: true });
      requireV3(second.evidence);
      expect(second.results[0]!.status).toBe(status === "pass" ? "pass" : "fail");
      if (status !== "pass") {
        expect(second.results[0]).toMatchObject({
          evidenceOccurrenceId: firstId,
          logPath: first.results[0]!.logPath,
          failureMessage: first.results[0]!.failureMessage,
        });
      }
      expect(await fs.readFile(originalPath)).toEqual(originalBytes);
      expect(second.evidence.occurrences).toEqual(expect.arrayContaining(original.occurrences));
      const finalBytes = JSON.stringify(second.evidence);
      for (const evidenceMode of ["full", "slim"] as const) {
        const projected = validateQaEvidenceSummaryJson({
          ...second.evidence,
          evidenceMode,
          entries:
            evidenceMode === "full"
              ? second.evidence.entries
              : second.evidence.entries.map(({ execution: _execution, ...entry }) => entry),
        });
        expect(projectQaEvidenceScenarioOutcomes(projected)).toHaveLength(1);
        const active = getEffectiveQaEvidenceEntries(projected);
        expect(active.map((entry) => entry.result.status)).toEqual(
          status === "pass" ? ["pass", "pass", "pass", "pass"] : ["fail", "pass", "fail"],
        );
        expect(active.slice(0, -1).map((entry) => entry.coverage)).toEqual(
          Array.from({ length: status === "pass" ? 3 : 2 }, () => childCoverage),
        );
        requireV3(projected);
        const containment = resolveQaEvidenceContainment(projected.occurrences, projected.entries);
        expect(
          active.slice(0, -1).map((entry) => {
            if (!("binding" in entry)) {
              throw new Error("expected bound child row");
            }
            return containment.projectCoverage(entry.binding.occurrenceId, entry.coverage);
          }),
        ).toEqual(
          Array.from({ length: status === "pass" ? 3 : 2 }, () => [
            { id: "qa.coverage", role: "primary" },
            { id: "qa.reporting", role: "secondary" },
          ]),
        );
        expect(active.at(-1)!.coverage).toEqual([]);
      }
      expect(JSON.stringify(second.evidence)).toBe(finalBytes);
    },
  );
});
