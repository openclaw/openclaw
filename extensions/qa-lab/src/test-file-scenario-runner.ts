import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { assertQaSuiteArtifactWritten } from "./artifact-assertion.js";
import { resolveQaArtifactPath, toRepoArtifactPath } from "./cli-paths.js";
import { captureQaEvidenceLaunchIdentity } from "./evidence-environment.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  QA_EVIDENCE_FILENAME,
  buildQaOccurrenceEvidenceSummary,
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceOccurrence,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Json,
  resolveQaEvidenceProfile,
} from "./evidence-summary.js";
import { sanitizeQaProgressValue } from "./progress-format.js";
import type { QaProviderMode } from "./providers/index.js";
import type {
  QaSeedScenarioWithSource,
  QaTestFileExecutionKind,
  QaTestFileScenario,
} from "./scenario-catalog.js";
import type { QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import { shellQuote } from "./shell-quote.js";
import {
  formatQaScenarioCommandOutput,
  runQaScenarioCommandLifecycle,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-command-lifecycle.js";
import {
  assertQaPreparedDockerEnvironment,
  dockerLaneName,
  isDockerE2eScenario,
  runDockerE2eBatch,
  splitDockerE2eScenarioBatches,
  type QaPreparedDockerEvidence,
} from "./test-file-scenario-docker-batch.js";
import {
  buildQaScenarioCommandSteps,
  testFileEvidenceBuilders,
  type QaScenarioCommandStep,
} from "./test-file-scenario-runner-commands.js";
import {
  readScriptProducerEvidence,
  statusFromProducerEntries,
} from "./test-file-scenario-script-evidence.js";
import { readNativeVitestExecutionFailure } from "./test-file-scenario-vitest-report.js";
export type { QaScenarioCommandExecution } from "./test-file-scenario-command-lifecycle.js";

type QaTestFileScenarioRunParams = {
  commandTimeoutMs?: number;
  evidenceMode?: QaScorecardEvidenceMode;
  evidenceAnchors?: readonly QaEvidenceOccurrence[];
  evidenceContinuation?: QaEvidenceSummaryV3Json;
  onEvidence?: (summary: QaEvidenceSummaryV3Json) => void;
  preparedDockerEvidence?: QaPreparedDockerEvidence;
  env?: NodeJS.ProcessEnv;
  envMode?: "replace";
  failFast?: boolean;
  onCommandOutput?: QaScenarioCommandExecution["onOutput"];
  outputDir: string;
  primaryModel: string;
  progress?: (message: string) => void;
  providerMode: QaProviderMode;
  repoRoot: string;
  runCommand?: QaScenarioCommandRunner;
  scenarios: readonly QaSeedScenarioWithSource[];
  writeEvidenceFile?: boolean;
};

type QaScenarioCommandRunner = typeof runQaScenarioCommandLifecycle;

type QaTestFileScenarioResult = {
  evidenceOccurrenceId?: string;
  durationMs: number;
  failureMessage?: string;
  includeFallbackEvidence?: boolean;
  logPath: string;
  producerEvidence?: QaEvidenceSummaryJson;
  producerArtifact?: QaEvidenceOccurrence["receipts"][number]["artifact"];
  scenario: QaTestFileScenario;
  status: QaEvidenceStatus;
};

type QaTestFileExecutionUnit =
  | {
      kind: "docker-batch";
      order: number;
      scenarios: Parameters<typeof runDockerE2eBatch>[0]["scenarios"];
      timeoutMs: number;
    }
  | {
      kind: "scenario";
      order: number;
      scenario: QaTestFileScenario;
      timeoutMs: number;
    };

export type QaTestFileScenarioRunResult = {
  evidence: QaEvidenceSummaryJson;
  evidencePath: string;
  executionKind: QaTestFileExecutionKind;
  outputDir: string;
  results: QaTestFileScenarioResult[];
};

const DEFAULT_QA_TEST_FILE_COMMAND_TIMEOUT_MS = 30 * 60_000;
export function isQaTestFileScenario(
  scenario: QaSeedScenarioWithSource,
): scenario is QaTestFileScenario {
  return (
    scenario.execution.kind === "vitest" ||
    scenario.execution.kind === "playwright" ||
    scenario.execution.kind === "script"
  );
}

function formatCommand(step: QaScenarioCommandStep) {
  return [step.command, ...step.args].map(shellQuote).join(" ");
}

function buildScenarioEvidenceTarget(scenario: QaTestFileScenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    sourcePath: scenario.execution.path,
    primaryCoverageIds: scenario.coverage?.primary ?? [],
    secondaryCoverageIds: scenario.coverage?.secondary ?? [],
    docsRefs: scenario.docsRefs,
    codeRefs: scenario.codeRefs,
  };
}

function withScenarioCoverage<T extends QaEvidenceSummaryJson["entries"][number]>(
  entry: T,
  scenario: QaTestFileScenario,
) {
  const primary = new Set(scenario.coverage?.primary ?? []);
  const secondary = new Set(scenario.coverage?.secondary ?? []);
  return {
    ...entry,
    coverage: entry.coverage
      .filter(({ id }) => primary.has(id) || secondary.has(id))
      .map((coverage) =>
        coverage.role === "primary" && !primary.has(coverage.id)
          ? { id: coverage.id, role: "secondary" }
          : coverage,
      ),
  };
}

async function runScenarioCommandSteps(params: {
  commandTimeoutMs: number;
  env: NodeJS.ProcessEnv;
  onCommandOutput?: QaScenarioCommandExecution["onOutput"];
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: QaTestFileScenario;
  steps: readonly QaScenarioCommandStep[];
}): Promise<QaTestFileScenarioResult> {
  const startedAt = Date.now();
  const logPath = path.join(params.outputDir, `${params.scenario.id}.log`);
  const logChunks: string[] = [];
  let failureMessage: string | undefined;
  for (const step of params.steps) {
    logChunks.push(`$ ${formatCommand(step)}\n`);
    try {
      const isNativeVitestStep =
        params.scenario.execution.kind !== "script" && step.args[0] === "scripts/run-vitest.mjs";
      const timeoutMs =
        params.scenario.execution.kind === "script"
          ? (params.scenario.execution.timeoutMs ?? params.commandTimeoutMs)
          : params.commandTimeoutMs;
      const result = await params.runCommand({
        command: step.command,
        args: step.args,
        cwd: params.repoRoot,
        env: params.env,
        ...(params.scenario.execution.kind === "script" && params.onCommandOutput
          ? { onOutput: params.onCommandOutput }
          : {}),
        timeoutMs,
      });
      logChunks.push(formatQaScenarioCommandOutput(result));
      if (result.failureMessage || result.exitCode !== 0 || result.signal) {
        failureMessage =
          result.failureMessage ??
          (result.signal
            ? `${path.basename(step.command)} terminated by ${result.signal}`
            : `${path.basename(step.command)} exited with ${result.exitCode}`);
        break;
      }
      // Chromium installation and script producers do not execute Vitest tests.
      // Only the final native test command can prove an assertion actually ran.
      if (isNativeVitestStep) {
        failureMessage = await readNativeVitestExecutionFailure(params);
        if (failureMessage) {
          logChunks.push(`${failureMessage}\n`);
          break;
        }
      }
    } catch (error) {
      failureMessage = formatErrorMessage(error);
      logChunks.push(`${failureMessage}\n`);
      break;
    }
    logChunks.push("\n");
  }
  await fs.writeFile(logPath, logChunks.join(""), "utf8");
  const durationMs = Math.max(1, Date.now() - startedAt);
  return {
    scenario: params.scenario,
    status: failureMessage ? "fail" : "pass",
    durationMs,
    logPath,
    ...(failureMessage ? { failureMessage } : {}),
  };
}

async function runQaTestFileScenario(params: {
  env: NodeJS.ProcessEnv;
  commandTimeoutMs: number;
  onCommandOutput?: QaScenarioCommandExecution["onOutput"];
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: QaTestFileScenario;
}) {
  const requiresProducerEvidence =
    params.scenario.execution.kind === "script" && !isDockerE2eScenario(params.scenario);
  if (requiresProducerEvidence) {
    const scenarioOutputDir = path.join(params.outputDir, params.scenario.id);
    // The enclosing attempt root is exclusive, so old runs remain untouched.
    await fs.mkdir(scenarioOutputDir);
  }
  const result = await runScenarioCommandSteps({
    ...params,
    steps: buildQaScenarioCommandSteps(params.scenario, { outputDir: params.outputDir }),
  });
  if (params.scenario.execution.kind !== "script") {
    return result;
  }
  let producerEvidenceResult: Awaited<ReturnType<typeof readScriptProducerEvidence>>;
  try {
    producerEvidenceResult = await readScriptProducerEvidence({
      outputDir: params.outputDir,
      repoRoot: params.repoRoot,
      scenario: params.scenario,
      requireCurrentRunEvidence: requiresProducerEvidence,
    });
  } catch (error) {
    if (result.status !== "pass") {
      return result;
    }
    return {
      ...result,
      failureMessage: `Script producer evidence is invalid: ${formatErrorMessage(error)}`,
      status: "fail" as const,
    };
  }
  if (!producerEvidenceResult.producerEvidence) {
    if (requiresProducerEvidence && result.status === "pass") {
      return {
        ...result,
        failureMessage: "Script exited successfully without writing fresh producer QA evidence.",
        status: "fail" as const,
      };
    }
    return result;
  }
  if (result.status !== "pass") {
    return {
      ...result,
      ...producerEvidenceResult,
      includeFallbackEvidence: true,
    };
  }
  return {
    ...result,
    ...producerEvidenceResult,
    ...statusFromProducerEntries({
      allowBlockedEvidence: params.scenario.execution.allowBlockedEvidence === true,
      entries: getEffectiveQaEvidenceEntries(producerEvidenceResult.producerEvidence),
      scenarioOutcomes:
        producerEvidenceResult.producerEvidence.schemaVersion === 3
          ? projectQaEvidenceScenarioOutcomes(producerEvidenceResult.producerEvidence)
          : undefined,
    }),
  };
}

function resolveScenarioTimeoutMs(scenario: QaTestFileScenario, commandTimeoutMs: number) {
  return scenario.execution.kind === "script"
    ? resolvePositiveTimerTimeoutMs(scenario.execution.timeoutMs, commandTimeoutMs)
    : commandTimeoutMs;
}

function buildExecutionUnits(params: {
  commandTimeoutMs: number;
  failFast: boolean;
  scenarios: readonly QaTestFileScenario[];
}): QaTestFileExecutionUnit[] {
  const scenarioOrder = new Map(params.scenarios.map((scenario, index) => [scenario, index]));
  const dockerBatchScenarios =
    !params.failFast && params.scenarios[0]?.execution.kind === "script"
      ? params.scenarios.filter(isDockerE2eScenario)
      : [];
  const dockerBatchGroups = new Map<number, typeof dockerBatchScenarios>();
  for (const scenario of dockerBatchScenarios) {
    const timeoutMs = resolveScenarioTimeoutMs(scenario, params.commandTimeoutMs);
    const group = dockerBatchGroups.get(timeoutMs) ?? [];
    group.push(scenario);
    dockerBatchGroups.set(timeoutMs, group);
  }
  const batchedScenarios = new Set<QaTestFileScenario>(dockerBatchScenarios);
  const units: QaTestFileExecutionUnit[] = [
    ...[...dockerBatchGroups].flatMap(([timeoutMs, scenarios]) =>
      splitDockerE2eScenarioBatches(scenarios).map((batch) => ({
        kind: "docker-batch" as const,
        order: Math.min(...batch.map((scenario) => scenarioOrder.get(scenario) ?? 0)),
        scenarios: batch,
        timeoutMs,
      })),
    ),
    ...params.scenarios
      .filter((scenario) => !batchedScenarios.has(scenario))
      .map((scenario) => ({
        kind: "scenario" as const,
        order: scenarioOrder.get(scenario) ?? 0,
        scenario,
        timeoutMs: resolveScenarioTimeoutMs(scenario, params.commandTimeoutMs),
      })),
  ];
  if (!params.failFast && params.scenarios[0]?.execution.kind === "script") {
    // Native producers stay serial because they may rebuild shared dist output.
    // Longest declared budgets run first so one late producer cannot starve at the suite deadline.
    units.sort((left, right) => right.timeoutMs - left.timeoutMs || left.order - right.order);
  } else {
    units.sort((left, right) => left.order - right.order);
  }
  return units;
}

function resolveTestFileExecutionKind(scenarios: readonly QaTestFileScenario[]) {
  const kinds = new Set(scenarios.map((scenario) => scenario.execution.kind));
  if (kinds.size > 1) {
    throw new Error(
      "qa suite cannot mix script, Vitest, and Playwright scenarios in one invocation.",
    );
  }
  const [kind] = kinds;
  return kind;
}

export async function runQaTestFileScenarios(
  params: QaTestFileScenarioRunParams,
): Promise<QaTestFileScenarioRunResult> {
  // Each scheduled instance owns its own object identity, even for repeated ids.
  const scenarios = params.scenarios
    .filter(isQaTestFileScenario)
    .map((scenario) => structuredClone(scenario));
  const kind = resolveTestFileExecutionKind(scenarios);
  if (!kind) {
    throw new Error("qa suite found no script, Vitest, or Playwright scenarios to run.");
  }
  await fs.mkdir(params.outputDir, { recursive: true });
  const runCommand = params.runCommand ?? runQaScenarioCommandLifecycle;
  const commandTimeoutMs = resolvePositiveTimerTimeoutMs(
    params.commandTimeoutMs,
    DEFAULT_QA_TEST_FILE_COMMAND_TIMEOUT_MS,
  );
  const env = params.envMode === "replace" ? (params.env ?? {}) : { ...process.env, ...params.env };
  const launch = structuredClone(
    params.evidenceAnchors?.[0]?.launch ?? (await captureQaEvidenceLaunchIdentity(params.repoRoot)),
  );
  if (params.preparedDockerEvidence) {
    assertQaPreparedDockerEnvironment(params.preparedDockerEvidence, env);
    const candidateRef = params.preparedDockerEvidence.receipt.identity.source.ref;
    if (launch.source.ref && candidateRef && launch.source.ref !== candidateRef) {
      throw new Error("Docker candidate source differs from the captured invocation source");
    }
  }
  const invocation = createQaEvidenceInvocation({
    scenarios,
    channel: null,
    launch,
    anchors: params.evidenceAnchors,
    continuation: params.evidenceContinuation,
  });
  const scenarioOrder = new Map(scenarios.map((scenario, index) => [scenario, index]));
  const observationIds = new Map<QaTestFileScenario, string>();
  const snapshot = () => {
    const summary = invocation.snapshot({
      generatedAt: new Date().toISOString(),
      evidenceMode: params.evidenceMode,
      profile: resolveQaEvidenceProfile({ env }),
    });
    const anchorOrder = new Map(invocation.anchors.map((anchor, index) => [anchor.id, index]));
    const containment = resolveQaEvidenceContainment(summary.occurrences, summary.entries);
    const byId = new Map(summary.occurrences.map((occurrence) => [occurrence.id, occurrence]));
    const entryOrder = new Map(
      summary.occurrences.map((member) => {
        const occurrence = byId.get(containment.rootId(member.id))!;
        return [
          member.id,
          occurrence.scenario?.kind === "observation"
            ? (anchorOrder.get(occurrence.scenario.instanceOccurrenceId) ?? 0)
            : 0,
        ] as const;
      }),
    );
    // Scheduling order stays stable even when longest-budget-first execution differs.
    summary.entries.sort(
      (a, b) =>
        (entryOrder.get(a.binding.occurrenceId) ?? 0) -
        (entryOrder.get(b.binding.occurrenceId) ?? 0),
    );
    return summary;
  };
  const publish = () => params.onEvidence?.(snapshot());
  publish();
  const attemptsDir = path.join(params.outputDir, "occurrences");
  await fs.mkdir(attemptsDir, { recursive: true });
  const start = (scenario: QaTestFileScenario) => {
    const id = invocation.begin(scenarioOrder.get(scenario)!);
    observationIds.set(scenario, id);
    return id;
  };
  const record = async (result: QaTestFileScenarioResult) => {
    const index = scenarioOrder.get(result.scenario)!;
    const id = observationIds.get(result.scenario)!;
    const artifact = {
      kind: "log",
      path: toRepoArtifactPath(params.repoRoot, result.logPath),
      source: kind,
      sha256: createHash("sha256")
        .update(await fs.readFile(result.logPath))
        .digest("hex"),
    };
    const receipts = [
      { id: `${id}:prepared`, phase: "prepared" as const, identity: launch, artifact },
      ...(result.producerArtifact
        ? [
            {
              id: `${id}:producer`,
              phase: "prepared" as const,
              identity: launch,
              artifact: result.producerArtifact,
            },
          ]
        : []),
      ...(params.preparedDockerEvidence && dockerLaneName(result.scenario)
        ? [structuredClone(params.preparedDockerEvidence.receipt)]
        : []),
    ];
    const producer = result.producerEvidence && structuredClone(result.producerEvidence);
    if (producer?.schemaVersion === 2) {
      // The v2 adapter returned repo-relative paths. Declare that known base
      // when these newly captured rows enter this v3 invocation.
      for (const entry of producer.entries) {
        for (const item of entry.execution?.artifacts ?? []) {
          item.path = toRepoArtifactPath(params.repoRoot, path.resolve(params.repoRoot, item.path));
        }
      }
    }
    const commandRows = () =>
      testFileEvidenceBuilders[kind]({
        artifactPaths: [{ kind: "log", path: artifact.path }],
        generatedAt: new Date().toISOString(),
        primaryModel: params.primaryModel,
        providerMode: params.providerMode,
        repoRoot: params.repoRoot,
        targets: [buildScenarioEvidenceTarget(result.scenario)],
        results: [
          {
            id: result.scenario.id,
            status: result.status,
            durationMs: result.durationMs,
            failureMessage: result.failureMessage,
          },
        ],
        env,
      }).entries;
    if (
      producer?.schemaVersion === 3 ||
      (producer?.entries.length && result.includeFallbackEvidence)
    ) {
      const commandEntries = commandRows();
      let childEvidence: QaEvidenceSummaryV3Json;
      if (producer.schemaVersion === 3) {
        childEvidence = producer;
      } else {
        // A v2 reporter has no recorded schedule. Bind its rows only to this
        // actual read, retaining a distinct producer observation without inventing history.
        const producerId = randomUUID();
        childEvidence = buildQaOccurrenceEvidenceSummary({
          generatedAt: producer.generatedAt,
          occurrences: [
            {
              id: producerId,
              parentCell: null,
              scenario: null,
              retryOf: null,
              terminalStatus: statusFromProducerEntries({
                allowBlockedEvidence: false,
                entries: getEffectiveQaEvidenceEntries(producer),
              }).status,
              assertions: null,
              launch,
              receipts: [],
            },
          ],
          entries: producer.entries.map((entry) => ({
            ...withScenarioCoverage(entry, result.scenario),
            binding: { occurrenceId: producerId, assertionId: null, receiptId: null },
            effective: true,
          })),
        });
      }
      invocation.complete(id, {
        status: result.status,
        childEvidence,
        ...(producer.schemaVersion === 3 && producer.occurrences.length > 0
          ? { childCoverage: commandEntries[0]!.coverage }
          : {}),
        receipts,
        entries: commandEntries.map((entry) => Object.assign({}, entry, { coverage: [] })),
      });
    } else {
      const hasProducerEntries = (producer?.entries.length ?? 0) > 0;
      invocation.complete(id, {
        status: hasProducerEntries
          ? statusFromProducerEntries({
              allowBlockedEvidence:
                result.scenario.execution.kind === "script" &&
                result.scenario.execution.allowBlockedEvidence === true,
              entries: producer?.entries ?? [],
            }).status
          : result.status,
        // Legacy reporters bind only to this observed invocation, never inferred
        // assertion ids or target receipts. Their rows stay immutable and ordered.
        entries: hasProducerEntries
          ? producer!.entries.map((entry) => withScenarioCoverage(entry, result.scenario))
          : commandRows(),
        receipts,
      });
    }
    result.evidenceOccurrenceId = invocation.select(index, id);
    if (result.evidenceOccurrenceId !== id) {
      const selected = invocation.selectedObservation(index)!;
      const first = selected.entries[0];
      result.status = selected.occurrence.terminalStatus ?? "fail";
      // Reuse producer precedence and fallback text: its first row may pass
      // while a later check owns the retained attempt's failure.
      result.failureMessage = statusFromProducerEntries({
        allowBlockedEvidence:
          result.scenario.execution.kind === "script" &&
          result.scenario.execution.allowBlockedEvidence === true,
        entries: selected.entries,
      }).failureMessage;
      result.durationMs = first?.result.timing?.wallMs ?? 0;
      const log = selected.occurrence.receipts.find((receipt) => receipt.artifact.kind === "log");
      if (log) {
        result.logPath = resolveQaArtifactPath(params.repoRoot, params.repoRoot, log.artifact.path);
      }
      delete result.producerEvidence;
      delete result.producerArtifact;
      delete result.includeFallbackEvidence;
    }
    publish();
  };
  const results: QaTestFileScenarioResult[] = [];
  const executionUnits = buildExecutionUnits({
    commandTimeoutMs,
    failFast: params.failFast === true,
    scenarios,
  });
  for (const unit of executionUnits) {
    if (unit.kind === "docker-batch") {
      params.progress?.(
        `native docker-batch start scenarios=${unit.scenarios.length} timeoutMs=${unit.timeoutMs}`,
      );
      const startedAt = Date.now();
      const ids = unit.scenarios.map(start);
      const batchDir = path.join(attemptsDir, ids[0]!);
      await fs.mkdir(batchDir);
      const batchResults = await runDockerE2eBatch({
        commandTimeoutMs: unit.timeoutMs,
        env,
        onCommandOutput: params.onCommandOutput,
        outputDir: batchDir,
        repoRoot: params.repoRoot,
        runCommand,
        scenarios: unit.scenarios,
      });
      for (const result of batchResults) {
        await record(result);
      }
      results.push(...batchResults);
      params.progress?.(
        `native docker-batch finish passed=${batchResults.filter((result) => result.status === "pass").length} failed=${batchResults.filter((result) => result.status !== "pass").length} durationMs=${Math.max(1, Date.now() - startedAt)}`,
      );
      continue;
    }
    const scenarioId = sanitizeQaProgressValue(unit.scenario.id);
    const id = start(unit.scenario);
    const attemptDir = path.join(attemptsDir, id);
    await fs.mkdir(attemptDir);
    params.progress?.(`native ${kind} start scenario=${scenarioId} timeoutMs=${unit.timeoutMs}`);
    const result = await runQaTestFileScenario({
      env,
      commandTimeoutMs,
      onCommandOutput: params.onCommandOutput,
      outputDir: attemptDir,
      repoRoot: params.repoRoot,
      runCommand,
      scenario: unit.scenario,
    });
    await record(result);
    results.push(result);
    params.progress?.(
      `native ${kind} finish scenario=${scenarioId} status=${result.status} durationMs=${result.durationMs}`,
    );
    if (params.failFast && result.status !== "pass") {
      break;
    }
  }
  results.sort(
    (left, right) =>
      (scenarioOrder.get(left.scenario) ?? 0) - (scenarioOrder.get(right.scenario) ?? 0),
  );
  const evidence = snapshot();
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  if (params.writeEvidenceFile ?? true) {
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await assertQaSuiteArtifactWritten("evidence", evidencePath);
  } else {
    await fs.rm(evidencePath, { force: true });
  }
  return {
    evidencePath,
    evidence,
    executionKind: kind,
    outputDir: params.outputDir,
    results,
  };
}
