import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  repoRootTokenArtifactPath,
  resolveQaArtifactPath,
  toRepoRelativePath,
} from "./cli-paths.js";
import { QaSuiteCleanupError } from "./errors.js";
import { captureQaEvidenceLaunchIdentity } from "./evidence-environment.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  buildQaSuiteEvidenceSummary,
  validateQaEvidenceSummaryJson,
  type QaEvidenceIdentity,
  type QaEvidenceOccurrence,
  type QaEvidenceSummaryJson,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryV3Entry,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import { normalizeQaTransportId } from "./qa-transport-registry.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type {
  QaSuiteEnvironment,
  QaSuiteResolvedRunContext,
  QaSuiteRunParams,
  QaSuiteScenarioResult,
} from "./suite-types.js";

export function describeQaSuiteInterruption(signal: AbortSignal | undefined, failure: unknown) {
  if (signal?.aborted) {
    return `suite cancelled: ${formatErrorMessage(signal.reason)}`;
  }
  if (failure instanceof QaSuiteCleanupError) {
    return `suite stopped after cleanup failure: ${formatErrorMessage(failure)}`;
  }
  return undefined;
}

/** Rebase both raw entries and bound receipts through the same artifact owner. */
export function rebaseQaSuiteEvidence(summary: QaEvidenceSummaryJson, from: string, to: string) {
  const rebased = structuredClone(summary);
  const artifacts = [
    ...rebased.entries.flatMap((entry) => entry.execution?.artifacts ?? []),
    ...(rebased.schemaVersion === 3
      ? rebased.occurrences.flatMap((occurrence) =>
          occurrence.receipts.map((receipt) => receipt.artifact),
        )
      : []),
  ];
  for (const artifact of artifacts) {
    if (
      artifact.source === "qa-suite" &&
      repoRootTokenArtifactPath(artifact.path) === null &&
      !path.isAbsolute(artifact.path)
    ) {
      // Parent receipts become ../ paths inside an isolated worker. Rebase
      // those too so returning history preserves its immutable artifact identity.
      artifact.path = toRepoRelativePath(to, path.resolve(from, artifact.path));
    }
  }
  return validateQaEvidenceSummaryJson(rebased);
}

async function readQaSelectedScenarioResult(
  context: Pick<QaSuiteResolvedRunContext, "repoRoot" | "outputDir">,
  occurrence: QaEvidenceOccurrence,
) {
  const receipt = occurrence.receipts.find(
    (item) => item.artifact.source === "qa-suite" && item.artifact.kind === "scenario-observation",
  );
  if (!receipt) {
    throw new Error("selected flow result has no captured artifact");
  }
  const bytes = await fs.readFile(
    resolveQaArtifactPath(context.repoRoot, context.outputDir, receipt.artifact.path),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.artifact.sha256) {
    throw new Error("selected flow result artifact changed");
  }
  // SAFETY: This owner's immutable result artifact matches its recorded hash; selection is checked below.
  const saved = JSON.parse(bytes.toString()) as { result: QaSuiteScenarioResult };
  if (
    saved.result.evidenceOccurrenceId !== occurrence.id ||
    saved.result.status !==
      (occurrence.terminalStatus === "skipped" ? "skip" : occurrence.terminalStatus)
  ) {
    throw new Error("selected flow result artifact disagrees with its observation");
  }
  return saved.result;
}

/** Flow lifecycle adapter: scheduling and selection remain with the invocation owner. */
export async function createQaSuiteEvidenceInvocation(
  params: QaSuiteRunParams | undefined,
  context: Pick<
    QaSuiteResolvedRunContext,
    "repoRoot" | "outputDir" | "selectedScenarios" | "providerMode" | "primaryModel" | "transportId"
  >,
  onResultCommitted?: (index: number, result: QaSuiteScenarioResult) => void,
) {
  const launch = structuredClone(
    params?.evidenceAnchors?.[0]?.launch ??
      (await captureQaEvidenceLaunchIdentity(context.repoRoot)),
  );
  const channel = params?.channelId ?? context.transportId;
  const invocation = createQaEvidenceInvocation({
    scenarios: context.selectedScenarios,
    channel,
    launch,
    anchors: params?.evidenceAnchors,
    continuation: params?.evidenceContinuation,
  });
  const snapshot = () =>
    invocation.snapshot({
      generatedAt: new Date().toISOString(),
      evidenceMode: params?.evidenceMode,
    });
  const publish = () => params?.onEvidence?.(snapshot());
  const recordedResults = new Map<string, QaSuiteScenarioResult>();
  const instanceIds = invocation.anchors.map(({ id }) => id);
  const startedIndexes = new Set<number>();
  const markStarted = (index: number) => {
    if (!startedIndexes.has(index)) {
      startedIndexes.add(index);
      params?.onScenarioStarted?.(instanceIds[index]!);
    }
  };
  const startedScenarios = () => ({
    startedScenarioIds: context.selectedScenarios
      .filter((_scenario, index) => startedIndexes.has(index))
      .map((scenario) => scenario.id),
    startedScenarioInstanceIds: [...startedIndexes].map((index) => instanceIds[index]!),
  });
  publish();

  async function record(
    index: number,
    id: string,
    result: QaSuiteScenarioResult,
    options: {
      diagnostic?: boolean;
      env?: QaSuiteEnvironment;
      selectedId?: string;
      importedEntries?: readonly QaEvidenceSummaryEntry[];
      childEvidence?: QaEvidenceSummaryJson;
    } = {},
  ) {
    const scenario = context.selectedScenarios[index];
    if (!scenario) {
      throw new Error(`unknown scheduled flow scenario ${index}`);
    }
    const observed = options.env?.gateway.evidenceIdentity;
    const runtimeIdentity: QaEvidenceIdentity | null = observed
      ? {
          source: { ref: null, integrity: null },
          runtime: { id: "openclaw", version: observed.version },
          package: null,
          protocol: `gateway:${observed.protocol}`,
          // The adapter's configured account is not a target acknowledgement.
          accountRef: null,
          // A connected local gateway does not prove live-channel/provider delivery.
          proofClass: null,
        }
      : null;
    const relativePath = path.join("artifacts", "occurrences", `${id}.json`);
    const artifactPath = path.join(context.outputDir, relativePath);
    const recordedResult = { ...result, evidenceOccurrenceId: id };
    const content = `${JSON.stringify({ result: recordedResult, launch, runtime: runtimeIdentity }, null, 2)}\n`;
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    // Attempt artifacts are never overwritten by retries or same-label instances.
    await fs.writeFile(artifactPath, content, { flag: "wx", mode: 0o600 });
    const artifact = {
      kind: "scenario-observation",
      path: relativePath.split(path.sep).join("/"),
      source: "qa-suite",
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const preparedId = `${id}:prepared`;
    const runtimeId = `${id}:runtime`;
    const childEvidence = options.childEvidence
      ? validateQaEvidenceSummaryJson(options.childEvidence)
      : undefined;
    if (childEvidence && childEvidence.schemaVersion !== 3) {
      throw new Error("retained flow child evidence requires recorded v3 custody");
    }
    const childContent = childEvidence ? `${JSON.stringify(childEvidence, null, 2)}\n` : undefined;
    const childPath = path.join("artifacts", "occurrences", `${id}.producer-evidence.json`);
    if (childContent !== undefined) {
      // The enclosing attempt owns this immutable bundle. Retrying it changes
      // containment activity, never the child's local rows, flags or receipts.
      await fs.writeFile(path.join(context.outputDir, childPath), childContent, {
        flag: "wx",
        mode: 0o600,
      });
    }
    const receipts = [
      { id: preparedId, phase: "prepared" as const, identity: launch, artifact },
      ...(childContent !== undefined
        ? [
            {
              id: `${id}:bundle`,
              phase: "prepared" as const,
              identity: launch,
              artifact: {
                kind: "producer-evidence",
                source: "qa-suite",
                path: childPath.split(path.sep).join("/"),
                sha256: createHash("sha256").update(childContent).digest("hex"),
              },
            },
          ]
        : []),
      ...(runtimeIdentity
        ? [{ id: runtimeId, phase: "runtime" as const, identity: runtimeIdentity, artifact }]
        : []),
    ];
    const rows = buildQaSuiteEvidenceSummary({
      // Stable presentation destinations belong to the row before admission.
      // Generation-specific links remain in the published suite summary.
      artifactPaths: [
        { kind: artifact.kind, path: artifact.path },
        { kind: "summary", path: "qa-suite-summary.json" },
        { kind: "report", path: "qa-suite-report.md" },
      ],
      channelId: channel,
      channelDriver: params?.channelDriver,
      generatedAt: new Date().toISOString(),
      env: {
        ...process.env,
        ...(launch.source.ref ? { OPENCLAW_QA_REF: launch.source.ref } : {}),
      },
      primaryModel: context.primaryModel,
      providerMode: context.providerMode,
      repoRoot: context.repoRoot,
      scenarioDefinitions: [scenario],
      scenarioResults: [result],
    }).entries;
    invocation.complete(id, {
      status: result.status === "skip" ? "skipped" : result.status,
      receipts,
      childEvidence,
      entries: (options.importedEntries ?? rows).map((entry) =>
        Object.assign({}, entry, options.diagnostic ? { coverage: [] } : {}, {
          binding: {
            occurrenceId: id,
            assertionId: null,
            receiptId: options.importedEntries ? null : runtimeIdentity ? runtimeId : preparedId,
          },
          effective: true,
        }),
      ),
    });
    const selectedId = invocation.select(index, options.selectedId ?? id);
    recordedResults.set(id, recordedResult);
    const selectedResult =
      selectedId === id
        ? recordedResult
        : result.evidenceOccurrenceId === selectedId
          ? structuredClone(result)
          : await resolveSelectedResult(index, selectedId);
    recordedResults.set(selectedId, selectedResult);
    // Reporting owns the committed selection even if an external observer throws.
    // The initial snapshot above has no result to hand off.
    onResultCommitted?.(index, selectedResult);
    publish();
    return selectedResult;
  }

  async function resolveSelectedResult(index: number, selectedId: string) {
    const retained = recordedResults.get(selectedId);
    if (retained) {
      return structuredClone(retained);
    }
    const result = await readQaSelectedScenarioResult(
      context,
      invocation.selectedObservation(index)!.occurrence,
    );
    recordedResults.set(selectedId, result);
    return structuredClone(result);
  }

  async function finalizeInterrupted(details: string | undefined) {
    if (details === undefined) {
      return;
    }
    for (const [index, scenario] of context.selectedScenarios.entries()) {
      const selected = invocation.selectedObservation(index);
      if (selected?.occurrence.terminalStatus != null) {
        // Continued selections have no result in this invocation's report yet.
        // Restore their verified artifacts without recording another attempt.
        if (!recordedResults.has(selected.occurrence.id)) {
          onResultCommitted?.(index, await resolveSelectedResult(index, selected.occurrence.id));
        }
        continue;
      }
      // A stopped schedule owns a diagnostic, not an executed attempt or a
      // replacement for any completed child selection.
      const id = invocation.begin(index, undefined, { diagnostic: true });
      await record(
        index,
        id,
        {
          name: scenario.title,
          status: "fail",
          details,
          steps: [{ name: "suite interruption", status: "fail", details }],
        },
        { diagnostic: true },
      );
    }
  }

  return {
    invocation,
    record,
    snapshot,
    publish,
    finalizeInterrupted,
    markStarted,
    startedScenarios,
  };
}

export type QaUnifiedPartitionResult = {
  evidenceSummaries: QaEvidenceSummaryJson[];
  scenarioResults: Array<{
    result: QaSuiteScenarioResult;
    scenarioId: string;
    instanceId?: string;
  }>;
  startedInstanceIds: readonly string[];
};

export function createQaPartitionEvidenceOwner(params: {
  scenarios: readonly QaSeedScenarioWithSource[];
  channel: string | null;
  launch: Parameters<typeof createQaEvidenceInvocation>[0]["launch"];
  outputDir: string;
  repoRoot: string;
  evidenceMode: QaSuiteRunParams["evidenceMode"];
  onScenarioStarted: QaSuiteRunParams["onScenarioStarted"];
  formatRestoredResult?: (result: QaSuiteScenarioResult) => QaSuiteScenarioResult;
  primaryModel: string;
  providerMode: QaSuiteResolvedRunContext["providerMode"];
}) {
  const options = () => ({
    generatedAt: new Date().toISOString(),
    evidenceMode: params.evidenceMode,
  });
  const initial = createQaEvidenceInvocation(params);
  const recordedResults = new Map<string, QaSuiteScenarioResult>();
  const recordResult = (result: QaSuiteScenarioResult) => {
    if (!result.evidenceOccurrenceId) {
      throw new Error("committed partition result has no observation");
    }
    recordedResults.set(result.evidenceOccurrenceId, structuredClone(result));
  };
  const startedInstanceIds = new Set<string>();
  const recordStart = (instanceId: string) => {
    if (!startedInstanceIds.has(instanceId)) {
      startedInstanceIds.add(instanceId);
      params.onScenarioStarted?.(instanceId);
    }
  };
  let current = initial.snapshot(options());
  let active = false;
  const parentFailures = new Map<number, string>();
  const unownedOccurrences: QaEvidenceOccurrence[] = [];
  const unownedEntries: QaEvidenceSummaryV3Entry[] = [];
  const rawRowOrder = new Map<string, number>();
  const orderedRows = (entries: readonly QaEvidenceSummaryV3Entry[]) => {
    const offsets = new Map<string, number>();
    return entries.map((entry) => {
      const id = entry.binding.occurrenceId;
      const offset = offsets.get(id) ?? 0;
      offsets.set(id, offset + 1);
      const key = `${id}:${offset}`;
      if (!rawRowOrder.has(key)) {
        rawRowOrder.set(key, rawRowOrder.size);
      }
      return { entry, order: rawRowOrder.get(key)! };
    });
  };
  const restore = () =>
    createQaEvidenceInvocation({
      ...params,
      anchors: resolveQaEvidenceContainment(current.occurrences, current.entries).rootInstances,
      continuation: current,
    });
  const receive = (summary: QaEvidenceSummaryV3Json) => {
    const anchors = resolveQaEvidenceContainment(
      summary.occurrences,
      summary.entries,
    ).rootInstances;
    if (
      JSON.stringify(anchors.map((item) => item.id)) !==
      JSON.stringify(initial.anchors.map((item) => item.id))
    ) {
      throw new Error("partition evidence replaced its scheduled instances");
    }
    const child = createQaEvidenceInvocation({
      ...params,
      anchors,
      continuation: summary,
    });
    const next = restore();
    for (const [index, anchor] of anchors.entries()) {
      const input = child.childInput(index);
      next.importChild(index, input);
      if (anchor.scenario?.kind === "instance") {
        if (anchor.scenario.resultOccurrenceId === null) {
          next.select(index, null);
        } else {
          next.select(index, anchor.scenario.resultOccurrenceId);
        }
      }
    }
    current = next.snapshot(options());
    orderedRows(current.entries);
  };
  const failure = (
    details: string,
    final: boolean,
    status: "fail" | "blocked" = "fail",
    unresolvedOnly = false,
  ) => {
    const invocation = restore();
    const diagnostics = buildQaSuiteEvidenceSummary({
      artifactPaths: [],
      // This diagnostic identifies the requested lane, not a connected transport.
      channelId: params.channel ?? normalizeQaTransportId(undefined),
      ...options(),
      env: process.env,
      primaryModel: params.primaryModel,
      providerMode: params.providerMode,
      repoRoot: params.repoRoot,
      scenarioDefinitions: params.scenarios,
      scenarioResults: params.scenarios.map((scenario) => ({
        name: scenario.title,
        status,
        details,
      })),
    }).entries;
    const results = params.scenarios.flatMap((scenario, index) => {
      if (
        unresolvedOnly &&
        invocation.selectedObservation(index)?.occurrence.terminalStatus != null
      ) {
        return [];
      }
      const selected = invocation.anchors[index]!.scenario;
      const childSelected = selected?.kind === "instance" ? selected.resultOccurrenceId : null;
      const previous = parentFailures.get(index) ?? null;
      const id = invocation.begin(index, previous, { diagnostic: true });
      invocation.complete(id, {
        status,
        entries: [{ ...diagnostics[index]!, coverage: [] }],
      });
      if (previous !== null || final) {
        invocation.select(index, id);
        if (!final && childSelected !== null) {
          invocation.select(index, childSelected);
        }
      }
      parentFailures.set(index, previous ?? id);
      const selectedId = final ? invocation.select(index, id) : undefined;
      const selectedDetails = final
        ? (invocation.selectedObservation(index)?.entries[0]?.result.failure?.reason ?? details)
        : details;
      return [
        {
          scenarioId: scenario.id,
          instanceId: invocation.anchors[index]!.id,
          result: {
            name: scenario.title,
            status: "fail" as const,
            details: selectedDetails,
            steps: [{ name: "suite partition", status: "fail" as const, details: selectedDetails }],
            ...(selectedId ? { evidenceOccurrenceId: selectedId } : {}),
          },
        },
      ];
    });
    current = invocation.snapshot(options());
    orderedRows(current.entries);
    if (final) {
      for (const { result } of results) {
        recordResult(result);
      }
    }
    return results;
  };
  const complete = (
    evidence: QaEvidenceSummaryJson,
    results: QaUnifiedPartitionResult["scenarioResults"],
    startedIds: readonly string[],
    recordedStartedInstanceIds?: readonly string[],
  ) => {
    if (evidence.schemaVersion === 3) {
      receive(evidence);
      const selected = new Set(
        restore().anchors.flatMap((anchor) =>
          anchor.scenario?.kind === "instance" && anchor.scenario.resultOccurrenceId !== null
            ? [anchor.scenario.resultOccurrenceId]
            : [],
        ),
      );
      const returned = results.map(({ result }) => result.evidenceOccurrenceId);
      if (
        new Set(returned).size !== returned.length ||
        returned.some((id) => id === undefined || !selected.has(id))
      ) {
        throw new Error("partition result does not match its selected observation");
      }
    }
    const invocation = restore();
    const remaining = [...results];
    const normalized: QaUnifiedPartitionResult["scenarioResults"] = [];
    const legacyOwners = new Map<string, string>();
    for (const [index, scenario] of params.scenarios.entries()) {
      const anchor = invocation.anchors[index]!;
      const selected =
        anchor.scenario?.kind === "instance" ? anchor.scenario.resultOccurrenceId : null;
      const unambiguous = params.scenarios.filter((item) => item.id === scenario.id).length === 1;
      const resultIndex = remaining.findIndex((candidate) =>
        evidence.schemaVersion === 3
          ? selected !== null && candidate.result.evidenceOccurrenceId === selected
          : unambiguous && candidate.scenarioId === scenario.id,
      );
      const result = resultIndex >= 0 ? remaining.splice(resultIndex, 1)[0] : undefined;
      const started =
        startedInstanceIds.has(anchor.id) ||
        (evidence.schemaVersion === 3
          ? recordedStartedInstanceIds?.includes(anchor.id) === true
          : unambiguous && startedIds.includes(scenario.id));
      if (started) {
        recordStart(anchor.id);
      }
      if (!result && !started) {
        continue;
      }
      if (evidence.schemaVersion === 2 || !result) {
        const id = invocation.begin(index, undefined, { diagnostic: !result });
        const status =
          result?.result.status === "skip" ? "skipped" : (result?.result.status ?? "fail");
        // Repeated labels cannot identify which scheduled instance owns a v2 row.
        const rows = unambiguous
          ? evidence.entries.filter((entry) => entry.test.id === scenario.id)
          : [];
        if (result && unambiguous) {
          legacyOwners.set(scenario.id, id);
        }
        invocation.complete(id, {
          status,
          entries: result
            ? rows
            : [
                {
                  test: { kind: "qa-scenario", id: scenario.id, title: scenario.title },
                  coverage: [],
                  result: {
                    status: "fail",
                    failure: { reason: "suite partition returned no scenario result" },
                  },
                },
              ],
        });
        const selectedId = invocation.select(index, id);
        normalized.push(
          result
            ? { ...result, result: { ...result.result, evidenceOccurrenceId: selectedId } }
            : {
                scenarioId: scenario.id,
                result: {
                  name: scenario.title,
                  status: "fail",
                  steps: [],
                  details: "suite partition returned no scenario result",
                  evidenceOccurrenceId: selectedId,
                },
              },
        );
      } else {
        normalized.push(result);
      }
      normalized.at(-1)!.instanceId = anchor.id;
      normalized.at(-1)!.scenarioId = scenario.id;
      const previous = parentFailures.get(index);
      if (previous !== undefined) {
        // This successful dispatch settles only its own infrastructure failure.
        // Child observations and the child's selected result remain independent.
        const selectedResult = normalized.at(-1)!.result.evidenceOccurrenceId!;
        const id = invocation.begin(index, previous, { diagnostic: true });
        invocation.complete(id, { status: "pass", entries: [] });
        invocation.select(index, id);
        invocation.select(index, selectedResult);
        parentFailures.delete(index);
      }
    }
    current = invocation.snapshot(options());
    if (evidence.schemaVersion === 2 && evidence.entries.length > 0) {
      const unownedId = randomUUID();
      const rawRows = evidence.entries.map((entry): QaEvidenceSummaryV3Entry => ({
        ...structuredClone(entry),
        binding: {
          occurrenceId: legacyOwners.get(entry.test.id) ?? unownedId,
          assertionId: null,
          receiptId: null,
        },
        effective: true,
      }));
      const unowned = rawRows.filter((entry) => entry.binding.occurrenceId === unownedId);
      if (unowned.length > 0) {
        // This invocation consumed these rows, but their labels establish no
        // scenario owner. Retain every diagnostic and ambiguous row exactly once.
        unownedOccurrences.push({
          id: unownedId,
          parentCell: null,
          scenario: null,
          retryOf: null,
          terminalStatus: null,
          assertions: null,
          launch: structuredClone(params.launch),
          receipts: [],
        });
        unownedEntries.push(...unowned);
      }
      orderedRows(rawRows);
    }
    orderedRows(current.entries);
    for (const { result } of normalized) {
      recordResult(result);
    }
    return normalized;
  };
  return {
    anchors: initial.anchors,
    input() {
      active = true;
      return {
        evidenceAnchors: restore().anchors,
        evidenceContinuation: current,
        onEvidence: receive,
        onScenarioStarted: recordStart,
      };
    },
    get active() {
      return active;
    },
    startedInstanceIds() {
      return [...startedInstanceIds];
    },
    recordResult,
    failure,
    async finalizeInterrupted(details: string, reportedIds: ReadonlySet<string | undefined>) {
      failure(details, true, "fail", true);
      const invocation = restore();
      const results: QaUnifiedPartitionResult["scenarioResults"] = [];
      for (const [index, scenario] of params.scenarios.entries()) {
        const selected = invocation.selectedObservation(index)!.occurrence;
        if (reportedIds.has(selected.id)) {
          continue;
        }
        let result = recordedResults.get(selected.id);
        if (!result) {
          // Rejected flow children cannot return their committed results. Read
          // the captured artifact; cancellation must not replace that selection.
          result = await readQaSelectedScenarioResult(params, selected);
          result = params.formatRestoredResult?.(result) ?? result;
          recordResult(result);
        }
        results.push({
          scenarioId: scenario.id,
          instanceId: invocation.anchors[index]!.id,
          result: structuredClone(result),
        });
      }
      return results;
    },
    complete,
    summary() {
      return rebaseQaSuiteEvidence(
        {
          ...current,
          occurrences: [...current.occurrences, ...unownedOccurrences],
          entries: orderedRows([...current.entries, ...unownedEntries])
            .toSorted((left, right) => left.order - right.order)
            .map(({ entry }) => entry),
        },
        params.outputDir,
        params.repoRoot,
      );
    },
  };
}
