import fs from "node:fs/promises";
import path from "node:path";
import type { QaRunnerTransportArtifacts } from "openclaw/plugin-sdk/qa-runner-runtime";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { assertQaSuiteArtifactWritten } from "./artifact-assertion.js";
import {
  buildQaSuiteEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaProviderMode } from "./model-selection.js";
import type { QaTransportDriver } from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { renderQaMarkdownReport } from "./report.js";
import type { RuntimeId } from "./runtime-parity.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import { splitModelRef } from "./suite-planning.js";
import { countQaSuiteFailedScenarios, type QaSuiteSummaryJson } from "./suite-summary.js";
import { createQaSuiteReportNotes } from "./suite-support.js";
import {
  rejectRemovedQaChannelDriverSelection,
  type QaSuiteScenarioResult,
} from "./suite-types.js";

/** Atomically replaces each file in order; summary-last is a completion signal, not a set transaction. */
export async function publishQaSuiteArtifactFiles(params: {
  outputDir: string;
  files: readonly { content: string | Uint8Array; filePath: string }[];
}) {
  await fs.mkdir(params.outputDir, { recursive: true });
  const dirMode = (await fs.stat(params.outputDir)).mode & 0o7777;
  for (const file of params.files) {
    await replaceFileAtomic({
      filePath: file.filePath,
      content: file.content,
      dirMode,
      mode: 0o600,
      preserveExistingMode: true,
      tempPrefix: `${path.basename(file.filePath)}.qa-artifact`,
      syncTempFile: true,
      syncParentDir: true,
      throwOnCleanupError: true,
    });
  }
}

export async function invalidateQaSuiteArtifactGeneration(outputDir: string) {
  for (const fileName of ["qa-suite-summary.json", QA_EVIDENCE_FILENAME, "qa-suite-report.md"]) {
    await fs.rm(path.join(outputDir, fileName), { force: true });
  }
}

export type QaSuiteSummaryJsonParams = {
  status?: QaSuiteSummaryJson["run"]["status"];
  scenarios: QaSuiteScenarioResult[];
  startedAt: Date;
  finishedAt: Date;
  metrics?: QaSuiteSummaryJson["metrics"];
  evidence?: QaSuiteSummaryJson["evidence"];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  channel?: string | null;
  channelDriver?: QaTransportDriver | null;
  channelCapabilityMatrixPath?: string | null;
  channelDriverSmokePath?: string | null;
  scenarioIds?: readonly string[];
  runtimePair?: [RuntimeId, RuntimeId];
};

/**
 * Strongly-typed shape of `qa-suite-summary.json`. The GPT-5.6 Luna parity gate
 * (agentic-parity-report.ts, #64441) and any future parity wrapper can
 * import this type instead of re-declaring the shape, so changes to the
 * summary schema propagate through to every consumer at type-check time.
 */
export type QaSuiteGatewayRssSample = NonNullable<
  NonNullable<QaSuiteSummaryJson["metrics"]>["gatewayProcessRssSamples"]
>[number];

export type QaSuiteGatewayHeapSnapshot = NonNullable<
  NonNullable<QaSuiteSummaryJson["metrics"]>["gatewayHeapSnapshots"]
>[number];

/**
 * Pure-ish JSON builder for qa-suite-summary.json. Exported so the GPT-5.6 Luna
 * parity gate (agentic-parity-report.ts, #64441) and any future parity
 * runner can assert-and-trust the provider/model that produced a given
 * summary instead of blindly accepting the caller's candidateLabel /
 * baselineLabel. Without the `run` block, a maintainer who swaps candidate
 * and baseline summary paths could silently produce a mislabeled verdict.
 *
 * `scenarioIds` is only recorded when the caller passed a non-empty array
 * (an explicit scenario selection). A missing or empty array means "no
 * filter, full lane-selected catalog", which the summary encodes as `null`
 * so parity/report tooling doesn't mistake a full run for an explicit
 * empty selection.
 */
export function buildQaSuiteSummaryJson(params: QaSuiteSummaryJsonParams): QaSuiteSummaryJson {
  rejectRemovedQaChannelDriverSelection(params);
  const primarySplit = splitModelRef(params.primaryModel);
  const alternateSplit = splitModelRef(params.alternateModel);
  return {
    scenarios: params.scenarios,
    counts: {
      total: params.scenarios.length,
      passed: params.scenarios.filter((scenario) => scenario.status === "pass").length,
      failed: countQaSuiteFailedScenarios(params.scenarios),
      skipped: params.scenarios.filter((scenario) => scenario.status === "skip").length,
    },
    ...(params.metrics ? { metrics: params.metrics } : {}),
    ...(params.evidence ? { evidence: params.evidence } : {}),
    run: {
      status: params.status ?? "completed",
      startedAt: params.startedAt.toISOString(),
      finishedAt: params.finishedAt.toISOString(),
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      primaryProvider: primarySplit?.provider ?? null,
      primaryModelName: primarySplit?.model ?? null,
      alternateModel: params.alternateModel,
      alternateProvider: alternateSplit?.provider ?? null,
      alternateModelName: alternateSplit?.model ?? null,
      fastMode: params.fastMode,
      concurrency: params.concurrency,
      channelDriver: params.channelDriver ?? null,
      channel: params.channel ?? null,
      channelCapabilityMatrixPath: params.channelCapabilityMatrixPath ?? null,
      // This persisted summary is unversioned; keep its existing key until a versioned migration.
      channelDriverSmokePath: params.channelDriverSmokePath ?? null,
      scenarioIds:
        params.scenarioIds && params.scenarioIds.length > 0 ? [...params.scenarioIds] : null,
      runtimePair: params.runtimePair ?? null,
    },
  };
}

export async function writeQaSuiteArtifacts(
  params: Omit<
    QaSuiteSummaryJsonParams,
    "evidence" | "channelCapabilityMatrixPath" | "channelDriverSmokePath"
  > & {
    repoRoot?: string;
    outputDir: string;
    scenarioDefinitions?: readonly QaSeedScenarioWithSource[];
    evidenceMode?: QaScorecardEvidenceMode;
    recordedEvidence?: QaEvidenceSummaryJson;
    transport: QaTransportAdapter;
    transportArtifacts?: QaRunnerTransportArtifacts;
    isolatedWorkers?: boolean;
    writeEvidenceFile?: boolean;
  },
) {
  const reportPath = path.join(params.outputDir, "qa-suite-report.md");
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  const transportEvidenceArtifacts = params.transportArtifacts?.artifacts ?? [];
  const channelCapabilityMatrixPath = transportEvidenceArtifacts.find(
    (artifact) => artifact.kind === "channel-capability-matrix",
  )?.path;
  const channelDriverSmokePath = transportEvidenceArtifacts.find(
    (artifact) => artifact.kind === "channel-driver-smoke",
  )?.path;
  const report = renderQaMarkdownReport({
    title: "OpenClaw QA Scenario Suite",
    inProgress: params.status === "running",
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    scenarios: params.scenarios,
    notes: createQaSuiteReportNotes({
      ...params,
      transportArtifactNotes: params.transportArtifacts?.reportNotes,
    }),
  });
  const artifactPaths = [
    { kind: "summary", path: path.basename(summaryPath) },
    { kind: "report", path: path.basename(reportPath) },
    ...transportEvidenceArtifacts,
  ];
  const evidence = params.recordedEvidence
    ? validateQaEvidenceSummaryJson(params.recordedEvidence)
    : params.scenarioDefinitions && params.scenarioDefinitions.length > 0
      ? buildQaSuiteEvidenceSummary({
          artifactPaths,
          evidenceMode: params.evidenceMode,
          channelId: params.channel ?? params.transport.id,
          channelDriver: params.channelDriver ?? undefined,
          env: process.env,
          generatedAt: params.finishedAt.toISOString(),
          primaryModel: params.primaryModel,
          providerMode: params.providerMode,
          repoRoot: params.repoRoot,
          scenarioDefinitions: params.scenarioDefinitions,
          scenarioResults: params.scenarios,
        })
      : undefined;
  const writeEvidenceFile = params.status !== "running" && (params.writeEvidenceFile ?? true);
  if (!writeEvidenceFile) {
    await fs.rm(evidencePath, { force: true });
  }
  await publishQaSuiteArtifactFiles({
    outputDir: params.outputDir,
    files: [
      { filePath: reportPath, content: report },
      ...(evidence && writeEvidenceFile
        ? [{ filePath: evidencePath, content: `${JSON.stringify(evidence, null, 2)}\n` }]
        : []),
      {
        filePath: summaryPath,
        content: `${JSON.stringify(
          buildQaSuiteSummaryJson({
            ...params,
            // Publication must not rewrite rows already admitted by a parent.
            // The gallery reads final presentation paths from this summary.
            ...(params.recordedEvidence ? { evidence } : {}),
            channelCapabilityMatrixPath: channelCapabilityMatrixPath ?? null,
            channelDriverSmokePath: channelDriverSmokePath ?? null,
          }),
          null,
          2,
        )}\n`,
      },
    ],
  });
  await assertQaSuiteArtifactWritten("report", reportPath);
  await assertQaSuiteArtifactWritten("summary", summaryPath);
  if (evidence && writeEvidenceFile) {
    await assertQaSuiteArtifactWritten("evidence", evidencePath);
  }
  return { evidence, evidencePath, report, reportPath, summaryPath };
}
