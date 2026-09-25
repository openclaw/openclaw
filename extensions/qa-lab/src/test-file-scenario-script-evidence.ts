import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveQaArtifactPath, toRepoArtifactPath, toRepoRelativePath } from "./cli-paths.js";
import {
  QA_EVIDENCE_FILENAME,
  type projectQaEvidenceScenarioOutcomes,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { isRepoRootRelativeRef } from "./repo-path.js";

async function readJsonBytesIfExists(filePath: string) {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")) as unknown, bytes };
  } catch (error) {
    throw new Error(`invalid JSON in ${filePath}: ${formatErrorMessage(error)}`, { cause: error });
  }
}

export async function readJsonFileIfExists(filePath: string): Promise<unknown> {
  return (await readJsonBytesIfExists(filePath))?.value;
}

// Producer artifact paths resolve against their evidence bundle. External
// artifacts remain absolute so consumers never receive traversal segments.
function resolveScriptProducerArtifactPath(params: {
  evidenceDir: string;
  repoRoot: string;
  artifactPath: string;
  explicitBase?: boolean;
}) {
  const absolutePath = resolveQaArtifactPath(
    params.repoRoot,
    params.evidenceDir,
    params.artifactPath,
  );
  if (params.explicitBase) {
    return toRepoArtifactPath(params.repoRoot, absolutePath);
  }
  const repoRelativePath = toRepoRelativePath(params.repoRoot, absolutePath);
  return isRepoRootRelativeRef(repoRelativePath) ? repoRelativePath : path.normalize(absolutePath);
}

function normalizeScriptProducerEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  evidencePath: string;
  repoRoot: string;
}): QaEvidenceSummaryJson {
  const evidenceDir = path.dirname(params.evidencePath);
  const evidence = structuredClone(params.evidence);
  const artifacts = [
    ...evidence.entries.flatMap((entry) => entry.execution?.artifacts ?? []),
    ...(evidence.schemaVersion === 3
      ? evidence.occurrences.flatMap((occurrence) =>
          occurrence.receipts.map((receipt) => receipt.artifact),
        )
      : []),
  ];
  for (const artifact of artifacts) {
    artifact.path = resolveScriptProducerArtifactPath({
      artifactPath: artifact.path,
      evidenceDir,
      repoRoot: params.repoRoot,
      explicitBase: evidence.schemaVersion === 3,
    });
  }
  return validateQaEvidenceSummaryJson(evidence);
}

function assertScenarioOwnsEvidencePath(scenarioOutputDir: string, evidencePath: string): void {
  const relativePath = path.relative(scenarioOutputDir, evidencePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("producer evidence must remain inside its scenario output directory");
  }
}

export function statusFromProducerEntries(params: {
  allowBlockedEvidence: boolean;
  entries: readonly QaEvidenceSummaryJson["entries"][number][];
  scenarioOutcomes?: ReturnType<typeof projectQaEvidenceScenarioOutcomes>;
}): { failureMessage?: string; status: QaEvidenceStatus } {
  const { allowBlockedEvidence, entries, scenarioOutcomes } = params;
  const failedEntry = entries.find((entry) => entry.result.status === "fail");
  const failedScenario = scenarioOutcomes?.find((outcome) => outcome.status === "fail");
  const blockedEntry = entries.find((entry) => entry.result.status === "blocked");
  const blockedScenario = scenarioOutcomes?.find((outcome) => outcome.status === "blocked");
  if (failedEntry || failedScenario) {
    return {
      failureMessage:
        failedEntry?.result.failure?.reason ??
        `${failedEntry?.test.id ?? failedScenario?.scenarioId} reported failed`,
      status: "fail",
    };
  }
  // Check the child's schedule before containment projects only the outer
  // attempt. Allowing terminal blocked checks never authorizes unfinished work.
  const unresolved = scenarioOutcomes?.find((outcome) => outcome.status === null);
  if (unresolved) {
    return {
      failureMessage: `Script producer has an unresolved scheduled scenario: ${unresolved.scenarioId}`,
      status: "blocked",
    };
  }
  if (entries.length === 0) {
    return {
      failureMessage: "Script exited successfully without reporting an executed producer check.",
      status: "fail",
    };
  }
  const hasPassed = entries.some((entry) => entry.result.status === "pass");
  if ((blockedEntry || blockedScenario) && (!allowBlockedEvidence || !hasPassed)) {
    return {
      failureMessage:
        blockedEntry?.result.failure?.reason ??
        `${blockedEntry?.test.id ?? blockedScenario?.scenarioId} reported blocked`,
      status: "blocked",
    };
  }
  if (
    entries.some((entry) => entry.result.status === "skipped") ||
    scenarioOutcomes?.some((outcome) => outcome.status === "skipped")
  ) {
    return { status: "skipped" };
  }
  return { status: "pass" };
}

export async function readScriptProducerEvidence(params: {
  outputDir: string;
  requireCurrentRunEvidence?: boolean;
  repoRoot: string;
  scenario: { id: string };
}): Promise<{
  producerEvidence?: QaEvidenceSummaryJson;
  producerArtifact?: { kind: string; path: string; source: string; sha256: string };
}> {
  const scenarioOutputDir = path.join(params.outputDir, params.scenario.id);
  const latestRun = await readJsonFileIfExists(path.join(scenarioOutputDir, "latest-run.json"));
  if (
    params.requireCurrentRunEvidence === true &&
    latestRun !== undefined &&
    (latestRun === null ||
      typeof latestRun !== "object" ||
      !("qaEvidence" in latestRun) ||
      typeof latestRun.qaEvidence !== "string" ||
      latestRun.qaEvidence.trim().length === 0)
  ) {
    throw new Error("latest-run.json does not identify a producer evidence bundle");
  }
  const latestEvidencePath =
    latestRun !== null &&
    typeof latestRun === "object" &&
    "qaEvidence" in latestRun &&
    typeof latestRun.qaEvidence === "string"
      ? latestRun.qaEvidence
      : undefined;
  const candidates = [
    latestEvidencePath,
    path.join(scenarioOutputDir, QA_EVIDENCE_FILENAME),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const evidencePath = path.isAbsolute(candidate)
      ? candidate
      : path.join(scenarioOutputDir, candidate);
    if (params.requireCurrentRunEvidence === true) {
      assertScenarioOwnsEvidencePath(scenarioOutputDir, evidencePath);
      const evidenceStat = await fs.stat(evidencePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      if (!evidenceStat) {
        continue;
      }
      assertScenarioOwnsEvidencePath(
        await fs.realpath(scenarioOutputDir),
        await fs.realpath(evidencePath),
      );
    }
    const captured = await readJsonBytesIfExists(evidencePath);
    if (captured === undefined) {
      continue;
    }
    const evidence = validateQaEvidenceSummaryJson(captured.value);
    return {
      producerArtifact: {
        kind: "producer-evidence",
        path: resolveScriptProducerArtifactPath({
          evidenceDir: path.dirname(evidencePath),
          repoRoot: params.repoRoot,
          artifactPath: path.resolve(evidencePath),
          explicitBase: true,
        }),
        source: "script",
        sha256: createHash("sha256").update(captured.bytes).digest("hex"),
      },
      producerEvidence: normalizeScriptProducerEvidence({
        evidence,
        evidencePath,
        repoRoot: params.repoRoot,
      }),
    };
  }
  return {};
}
