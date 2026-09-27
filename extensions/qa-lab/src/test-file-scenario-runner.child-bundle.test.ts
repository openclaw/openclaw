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
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";
import {
  buildScriptProducerEvidence,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  QA_TEST_RUNNER_DEFAULTS,
  resolveScriptAttemptOutputDir,
  writeScriptProducerEvidence,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
afterEach(() => harness.cleanup());

describe("native attempt child bundles", () => {
  it.each(
    (["blocked", "skipped"] as const).flatMap((status) =>
      [undefined, "original failing check"].map((reason) => ({ status, reason })),
    ),
  )(
    "retains a later failing producer check and its $reason diagnostic after a $status retry",
    async ({ status, reason }) => {
      const root = await harness.makeTempRepo("qa-native-multicheck-retry-");
      const scenarios = [makeTestFileScenario("script", "producer.mjs")];
      const run = async (continuation?: QaEvidenceSummaryV3Json) =>
        runQaTestFileScenarios({
          repoRoot: root,
          outputDir: path.join(root, "out"),
          scenarios,
          ...QA_TEST_RUNNER_DEFAULTS,
          ...(continuation
            ? {
                evidenceContinuation: continuation,
                evidenceAnchors: resolveQaEvidenceContainment(
                  continuation.occurrences,
                  continuation.entries,
                ).rootInstances,
              }
            : {}),
          runCommand: async (command) => {
            await writeScriptProducerEvidence({
              outputDir: resolveScriptAttemptOutputDir(command),
              producerId: "passing-check",
              status: continuation ? status : "pass",
              additionalEntries: continuation
                ? []
                : buildScriptProducerEvidence({
                    status: "fail",
                    producerId: "failing-check",
                    failureReason: reason,
                  }).entries,
            });
            return { exitCode: 0, stdout: "original command output", stderr: "" };
          },
        });
      const first = await run();
      if (first.evidence.schemaVersion !== 3) {
        throw new Error("expected v3 adapter");
      }
      expect(first.results[0]?.failureMessage).toBe(reason ?? "failing-check reported failed");
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
    },
  );

  it.each(["pass", "fail", "blocked", "skipped"] as const)(
    "retains an actual independent v3 subprocess across a %s retry in full and slim projections",
    async (status) => {
      const root = await harness.makeTempRepo("qa-native-child-");
      const script = path.join(root, "producer.mjs");
      const api = pathToFileURL(path.resolve("extensions/qa-lab/test-api.ts")).href;
      await fs.writeFile(
        script,
        `
import fs from "node:fs/promises";
import path from "node:path";
import { createQaEvidenceInvocation } from ${JSON.stringify(api)};
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const status = value("--status");
const output = value("--artifact-base");
const source = { ref: null, integrity: null };
const launch = {
  source, runtime: { id: "node", version: process.version }, package: null,
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
    coverage: [
      { id: "qa.coverage", role: "primary" },
      { id: "qa.reporting", role: "primary" },
      { id: "other.claim", role: "primary" },
    ],
    result: { status: result },
  }] });
  owner.select(index, id);
}
if (value("--open") === "true") owner.begin(2);
await fs.writeFile(path.join(output, "qa-evidence.json"),
  JSON.stringify(owner.snapshot({ generatedAt: new Date().toISOString() })), { flag: "wx" });
console.log("child pid=" + process.pid);
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
          outputDir: path.join(root, "out"),
          ...QA_TEST_RUNNER_DEFAULTS,
          scenarios: [scenario],
          commandTimeoutMs: 30_000,
          ...(continuation
            ? {
                evidenceContinuation: continuation,
                evidenceAnchors: resolveQaEvidenceContainment(
                  continuation.occurrences,
                  continuation.entries,
                ).rootInstances,
              }
            : {}),
        });
      };
      const first = await run("fail", "7");
      if (first.evidence.schemaVersion !== 3) {
        throw new Error("expected invocation evidence");
      }
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
      if (original.schemaVersion !== 3) {
        throw new Error("expected child v3");
      }
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
            if (incomplete.evidence.schemaVersion !== 3) {
              throw new Error("expected incomplete child bundle evidence");
            }
            expect(incomplete.results[0]).toMatchObject({
              status: "blocked",
              failureMessage: expect.stringContaining("unresolved scheduled scenario"),
            });
            expect(projectQaEvidenceScenarioOutcomes(incomplete.evidence)).toEqual([
              expect.objectContaining({ status: "blocked" }),
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
        // A terminal pointer without an effective row remains unresolved by the
        // canonical reader, even when terminal blocked evidence is allowed.
        expect(terminal.results[0]).toMatchObject({
          status: "blocked",
          failureMessage: expect.stringContaining("unresolved scheduled scenario"),
        });
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
      if (second.evidence.schemaVersion !== 3) {
        throw new Error("expected invocation evidence");
      }
      expect(second.results[0]!.status).toBe(status === "pass" ? "pass" : "fail");
      if (status !== "pass") {
        expect(second.results[0]).toMatchObject({
          evidenceOccurrenceId: firstId,
          logPath: first.results[0]!.logPath,
          failureMessage: first.results[0]!.failureMessage,
        });
      }
      expect(await fs.readFile(originalPath)).toEqual(originalBytes);
      for (const occurrence of original.occurrences) {
        expect(second.evidence.occurrences.find((item) => item.id === occurrence.id)).toEqual(
          occurrence,
        );
      }
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
          Array.from({ length: status === "pass" ? 3 : 2 }, () => [
            { id: "qa.coverage", role: "primary" },
            { id: "qa.reporting", role: "primary" },
            { id: "other.claim", role: "primary" },
          ]),
        );
        if (projected.schemaVersion !== 3) {
          throw new Error("expected occurrence evidence");
        }
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

  it.each(["pass", "fail", "blocked", "skipped"] as const)(
    "selects the whole v2 producer and command attempt after %s",
    async (status) => {
      const root = await harness.makeTempRepo("qa-native-v2-retry-");
      const scenarios = [makeTestFileScenario("script", "producer.mjs")];
      const run = async (
        next: typeof status,
        exitCode: number,
        continuation?: QaEvidenceSummaryV3Json,
      ) =>
        runQaTestFileScenarios({
          repoRoot: root,
          outputDir: path.join(root, "out"),
          scenarios,
          ...QA_TEST_RUNNER_DEFAULTS,
          ...(continuation
            ? {
                evidenceContinuation: continuation,
                evidenceAnchors: resolveQaEvidenceContainment(
                  continuation.occurrences,
                  continuation.entries,
                ).rootInstances,
              }
            : {}),
          runCommand: async (command) => {
            await writeScriptProducerEvidence({
              outputDir: resolveScriptAttemptOutputDir(command),
              status: next,
              failureReason: next === "fail" ? "producer failed" : undefined,
            });
            return { exitCode, stdout: "", stderr: "" };
          },
        });
      const first = await run("fail", 7);
      if (first.evidence.schemaVersion !== 3) {
        throw new Error("expected v3 adapter");
      }
      const firstRows = structuredClone(first.evidence.entries);
      const second = await run(status, status === "fail" ? 7 : 0, first.evidence);
      expect(second.evidence.entries.slice(0, 2).map((entry) => entry.result)).toEqual(
        firstRows.map((entry) => entry.result),
      );
      expect(
        getEffectiveQaEvidenceEntries(second.evidence).map((entry) => entry.result.status),
      ).toEqual(status === "pass" ? ["pass"] : ["fail", "fail"]);
      expect(projectQaEvidenceScenarioOutcomes(second.evidence)[0]?.status).toBe(
        status === "pass" ? "pass" : "fail",
      );
    },
  );
});
