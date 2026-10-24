import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { qaMaturityTaxonomyIdentity, readQaMaturityTaxonomySource } from "./scorecard-taxonomy.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { runQaSuiteWithInfraRetry } from "./suite-infra-retry.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { artifactPaths, childResult, createTestLab } from "./suite-runtime-parity.test-support.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteResolvedRunContext, QaSuiteResult, QaSuiteRunParams } from "./suite-types.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
let repoRoot: string;
let outputDir: string;
function containedEvidence(evidence: QaEvidenceSummaryV3Json, ids: Set<string>) {
  return {
    occurrences: evidence.occurrences.filter((item) => ids.has(item.id)),
    entries: evidence.entries.filter((entry) => ids.has(entry.binding.occurrenceId)),
  };
}

function rootInstances(evidence: QaEvidenceSummaryV3Json) {
  return resolveQaEvidenceContainment(evidence.occurrences, evidence.entries).rootInstances;
}

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

const mocks = vi.hoisted(() => ({
  readQaBootstrapScenarioCatalog: vi.fn(),
  runQaFlowSuiteStandard: vi.fn(),
  writeQaSuiteArtifacts: vi.fn(),
}));

vi.mock("./scenario-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-catalog.js")>()),
  readQaBootstrapScenarioCatalog: mocks.readQaBootstrapScenarioCatalog,
}));

vi.mock("./suite-planning.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-planning.js")>()),
  resolveQaSuiteOutputDir: vi.fn(
    async (_repoRoot: string, requestedOutputDir?: string) => requestedOutputDir ?? "/qa-output",
  ),
}));

vi.mock("./suite-run-standard.js", () => ({
  runQaFlowSuiteStandard: mocks.runQaFlowSuiteStandard,
}));

vi.mock("./suite-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-artifacts.js")>()),
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));

beforeEach(async () => {
  repoRoot = await tempDirs.makeTempDir("qa-parity-control-ui-");
  outputDir = path.join(repoRoot, "output");
  vi.clearAllMocks();
  mocks.readQaBootstrapScenarioCatalog.mockReturnValue({
    scenarios: [
      makeQaSuiteTestScenario("runtime-channel", { surface: "channel" }),
      makeQaSuiteTestScenario("runtime-control-ui", { surface: "control-ui" }),
    ],
  });
  mocks.runQaFlowSuiteStandard.mockImplementation(
    async (
      params: QaSuiteRunParams | undefined,
      context: QaSuiteResolvedRunContext,
    ): Promise<QaSuiteResult> => childResult(params, context.selectedScenarios, context.outputDir),
  );
  mocks.writeQaSuiteArtifacts.mockImplementation(async (params) => ({
    evidence: params.recordedEvidence,
    ...artifactPaths,
  }));
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("runtime parity Control UI ownership", () => {
  it.each(["pass", "skip"] as const)(
    "retains raw slim runtime cells across a %s retry",
    async (retryStatus) => {
      const scenario = makeQaSuiteTestScenario("runtime-channel", { surface: "channel" });
      scenario.assertions = [
        {
          id: "child-result",
          meaning: "the runtime child owns its observed result",
          coverage: [{ id: "channels.dm", role: "primary" }],
        },
      ];
      mocks.readQaBootstrapScenarioCatalog.mockReturnValue({ scenarios: [scenario] });
      const original = mocks.runQaFlowSuiteStandard.getMockImplementation()!;
      let calls = 0;
      mocks.runQaFlowSuiteStandard.mockImplementation(async (params, context) => {
        const recording = await createQaSuiteEvidenceInvocation(params, context);
        const id = recording.invocation.begin(0);
        recording.publish();
        if (++calls === 2) {
          throw Object.assign(new Error("infrastructure after the first runtime failed"), {
            code: "ECONNRESET",
          });
        }
        const result = await original(params, context);
        const status = calls === 1 ? "fail" : calls === 3 ? retryStatus : "pass";
        const evidenceStatus = status === "skip" ? "skipped" : status;
        const content = JSON.stringify({ runtime: params.forcedRuntime, status });
        await fs.mkdir(context.outputDir, { recursive: true });
        await fs.writeFile(path.join(context.outputDir, "runtime-observation.json"), content);
        const receiptId = `${id}:runtime`;
        recording.invocation.complete(id, {
          status: evidenceStatus,
          entries: [
            {
              test: { kind: "flow", id: scenario.id, title: scenario.title },
              coverage: [{ id: "channels.dm", role: "primary" }],
              result: { status: evidenceStatus },
              binding: { occurrenceId: id, assertionId: "child-result", receiptId },
              effective: true,
            },
          ],
          receipts: [
            {
              id: receiptId,
              phase: "runtime",
              identity: {
                ...recording.invocation.anchors[0]!.launch,
                runtime: { id: params.forcedRuntime!, version: "fixture-version" },
              },
              artifact: {
                kind: "fixture",
                source: "qa-suite",
                path: "runtime-observation.json",
                sha256: sha256(content),
              },
            },
          ],
        });
        recording.invocation.select(0, id);
        recording.publish();
        result.scenarios[0] = { ...result.scenarios[0]!, status, evidenceOccurrenceId: id };
        result.evidence = recording.snapshot();
        return result;
      });
      let continuation: QaEvidenceSummaryV3Json | undefined;
      let firstAttempt: QaEvidenceSummaryV3Json | undefined;
      const lab = createTestLab();
      const result = await runQaSuiteWithInfraRetry((attempt) =>
        runQaFlowSuiteFromRuntime({
          repoRoot,
          outputDir,
          providerMode: "mock-openai",
          scenarioIds: [scenario.id],
          runtimePair: ["openclaw", "codex"],
          evidenceMode: "slim",
          lab,
          startLab: async () => lab,
          ...(continuation
            ? {
                evidenceAnchors: rootInstances(continuation),
                evidenceContinuation: continuation,
              }
            : {}),
          onEvidence: (summary) => {
            continuation = structuredClone(summary);
            if (attempt === 0) {
              firstAttempt = structuredClone(summary);
            }
          },
        }),
      );
      expect(
        mocks.runQaFlowSuiteStandard.mock.calls.map(([params]) => params.forcedRuntime),
      ).toEqual(["openclaw", "codex", "openclaw", "codex"]);
      const evidence = result.evidence as QaEvidenceSummaryV3Json;
      const expectedStatus = retryStatus === "pass" ? "pass" : "fail";
      expect(result.scenarios[0]?.status).toBe(expectedStatus);
      expect(projectQaEvidenceScenarioOutcomes(evidence)).toEqual([
        expect.objectContaining({ scenarioId: scenario.id, status: expectedStatus }),
      ]);
      const effective = getEffectiveQaEvidenceEntries(evidence);
      expect(effective.length).toBeGreaterThan(0);
      expect(effective.every((row) => row.result.status === expectedStatus)).toBe(true);
      const firstComparison = firstAttempt!.occurrences.find((item) => item.childOccurrenceIds)!;
      const retainedIds = new Set(firstComparison.childOccurrenceIds);
      expect(containedEvidence(evidence, retainedIds)).toEqual(
        containedEvidence(firstAttempt!, retainedIds),
      );
      expect(
        evidence.occurrences.some(
          (item) =>
            retainedIds.has(item.id) && item.assertions?.length && item.terminalStatus === null,
        ),
      ).toBe(true);
      for (const owner of evidence.occurrences.filter((item) => item.childOccurrenceIds)) {
        const receipts = owner.receipts.filter(
          (receipt) => receipt.artifact.kind === "producer-evidence",
        );
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.phase).toBe("prepared");
        const bytes = await fs.readFile(path.join(outputDir, receipts[0]!.artifact.path));
        expect(sha256(bytes)).toBe(receipts[0]!.artifact.sha256);
        const bundle = JSON.parse(bytes.toString()) as QaEvidenceSummaryV3Json;
        const ids = new Set(owner.childOccurrenceIds);
        expect({ occurrences: bundle.occurrences, entries: bundle.entries }).toEqual(
          containedEvidence(evidence, ids),
        );
        for (const child of bundle.occurrences) {
          for (const receipt of child.receipts) {
            const raw = await fs.readFile(path.join(outputDir, receipt.artifact.path));
            expect(sha256(raw)).toBe(receipt.artifact.sha256);
          }
        }
      }
      const cell = {
        scenarioId: scenario.id,
        executionKind: "flow" as const,
        channel: "qa-channel",
      };
      const plan = qaProfileEvidencePlan.build({
        profile: "all",
        taxonomyIdentity: qaMaturityTaxonomyIdentity(
          readQaMaturityTaxonomySource(path.resolve(import.meta.dirname, "../../../taxonomy.yaml")),
        ),
        membershipScenarios: [scenario],
        selectedScenarios: [scenario],
        excludedScenarios: [],
        expectedCells: [cell],
        observedCells: [cell],
        proofRequirements: [
          {
            id: "runtime-proof",
            coverageId: "channels.dm",
            obligation: "required",
            owner: "fixture-owner",
            acceptedRef: "qa/fixtures/acceptance",
            retryAcceptance: "selected-attempt",
            alternatives: [
              { runtime: "openclaw", runtimeVersion: "fixture-version" },
              { runtime: "codex", runtimeVersion: "fixture-version" },
            ],
          },
        ],
      });
      const raw = structuredClone(evidence);
      expect(qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.qualified).toBe(
        retryStatus === "pass",
      );
      plan.proofRequirements![0]!.retryAcceptance = "all-recorded-attempts";
      expect(
        qaProfileEvidencePlan
          .evaluateProof(plan, evidence)[0]
          ?.checks.some((check) => check.status === "failed"),
      ).toBe(true);
      expect(evidence).toEqual(raw);
    },
  );

  it("preserves repeated parity starts without merging progress slots", async () => {
    const lab = createTestLab();
    const result = await runQaFlowSuiteFromRuntime({
      repoRoot,
      outputDir,
      providerMode: "mock-openai",
      concurrency: 1,
      scenarioIds: ["runtime-channel", "runtime-channel"],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
    });
    expect(mocks.runQaFlowSuiteStandard).toHaveBeenCalledTimes(4);
    expect(result.startedScenarioIds).toEqual(["runtime-channel", "runtime-channel"]);
    const evidence = result.evidence as QaEvidenceSummaryV3Json;
    const roots = rootInstances(evidence);
    expect(roots).toHaveLength(2);
    const comparisons = roots.map((root) =>
      evidence.occurrences.find(
        (item) =>
          item.id ===
          (root.scenario?.kind === "instance" ? root.scenario.resultOccurrenceId : null),
      )!,
    );
    const childIds = comparisons.flatMap((item) => item.childOccurrenceIds ?? []);
    expect(new Set(childIds).size).toBe(childIds.length);
    expect(
      evidence.occurrences.filter(
        (item) => childIds.includes(item.id) && item.scenario?.kind === "instance",
      ),
    ).toHaveLength(4);
    const snapshots = vi
      .mocked(lab.setScenarioRun)
      .mock.calls.map(([next]) => next?.scenarios.map((item) => item.status));
    expect(snapshots).toContainEqual(["pass", "pending"]);
    expect(snapshots.at(-1)).toEqual(["pass", "pass"]);
  });
});
