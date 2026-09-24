import { randomUUID } from "node:crypto";
import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  buildQaOccurrenceEvidenceSummary,
  validateQaEvidenceSummaryJson,
  type QaEvidenceAssertion,
  type QaEvidenceIdentity,
  type QaEvidenceOccurrence,
  type QaEvidenceStatus,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Entry,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import type { QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";

type ScheduledScenario = {
  id: string;
  execution: { kind: "flow" | "script" | "vitest" | "playwright" };
  assertions?: readonly QaEvidenceAssertion[];
};

/**
 * One invocation owns scheduling and final selection. Children may add immutable
 * observations, but cannot overwrite a parent's selected result or launch facts.
 */
export function createQaEvidenceInvocation(params: {
  scenarios: readonly ScheduledScenario[];
  channel: string | null;
  launch: QaEvidenceIdentity;
  anchors?: readonly QaEvidenceOccurrence[];
  continuation?: QaEvidenceSummaryV3Json;
}) {
  const launch = structuredClone(params.launch);
  const declarations = params.scenarios.map((scenario) =>
    scenario.assertions ? structuredClone([...scenario.assertions]) : null,
  );
  if (params.anchors && params.anchors.length !== params.scenarios.length) {
    throw new Error("child evidence scheduling count does not match its invocation owner");
  }
  const anchors = params.scenarios.map((scenario, index): QaEvidenceOccurrence => {
    const supplied = params.anchors?.[index];
    if (
      supplied &&
      (supplied.scenario?.kind !== "instance" ||
        supplied.parentCell?.scenarioId !== scenario.id ||
        supplied.parentCell.executionKind !== scenario.execution.kind ||
        supplied.parentCell.channel !== params.channel ||
        JSON.stringify(supplied.launch) !== JSON.stringify(launch))
    ) {
      throw new Error("child evidence scheduling does not match its invocation owner");
    }
    return supplied
      ? structuredClone(supplied)
      : {
          id: randomUUID(),
          parentCell: {
            scenarioId: scenario.id,
            executionKind: scenario.execution.kind,
            channel: params.channel,
          },
          scenario: { kind: "instance", resultOccurrenceId: null },
          retryOf: null,
          terminalStatus: null,
          assertions: null,
          launch: structuredClone(launch),
          receipts: [],
        };
  });
  const observations: QaEvidenceOccurrence[] = [];
  const entries: QaEvidenceSummaryV3Entry[] = [];
  const pendingChildren = new Map<
    number,
    {
      observationOffset: number;
      entryOffset: number;
      additions: QaEvidenceOccurrence[];
      completions: QaEvidenceOccurrence[];
      rows: QaEvidenceSummaryV3Entry[];
      updates: Array<{ occurrenceId: string; effective: boolean }>;
    }
  >();
  if (params.continuation) {
    const continued = validateQaEvidenceSummaryJson(params.continuation);
    if (continued.schemaVersion !== 3) {
      throw new Error("continued evidence requires recorded v3 invocation custody");
    }
    const containment = resolveQaEvidenceContainment(continued.occurrences, continued.entries);
    const continuedAnchors = continued.occurrences.filter(
      (occurrence) =>
        occurrence.scenario?.kind === "instance" && !containment.parentById.has(occurrence.id),
    );
    if (!params.anchors || JSON.stringify(continuedAnchors) !== JSON.stringify(anchors)) {
      throw new Error("continued evidence does not match the captured invocation");
    }
    const anchorIds = new Set(anchors.map((anchor) => anchor.id));
    const continuedObservations = continued.occurrences.filter(
      (occurrence) => !anchorIds.has(occurrence.id),
    );
    if (
      continuedObservations.some(
        (occurrence) =>
          !containment.parentById.has(occurrence.id) &&
          (occurrence.scenario?.kind !== "observation" ||
            !anchorIds.has(occurrence.scenario.instanceOccurrenceId) ||
            JSON.stringify(occurrence.launch) !== JSON.stringify(launch)),
      )
    ) {
      throw new Error("continued evidence contains a foreign observation");
    }
    observations.push(...structuredClone(continuedObservations));
    entries.push(...structuredClone(continued.entries));
  }

  function anchorFor(index: number) {
    const anchor = anchors[index];
    if (!anchor) {
      throw new Error(`unknown scheduled evidence instance ${index}`);
    }
    return anchor;
  }

  function previousFailure(index: number) {
    const selected = anchorFor(index).scenario;
    let id = selected?.kind === "instance" ? selected.resultOccurrenceId : null;
    if (id === null || observationFor(id).terminalStatus !== "fail") {
      return null;
    }
    for (;;) {
      const successor = observations.find((occurrence) => occurrence.retryOf === id);
      if (!successor) {
        return observationFor(id).terminalStatus === "fail" ? id : null;
      }
      id = successor.id;
    }
  }

  function begin(
    index: number,
    retryOf: string | null = previousFailure(index),
    options: { diagnostic?: boolean } = {},
  ) {
    const anchor = anchorFor(index);
    const occurrence: QaEvidenceOccurrence = {
      id: randomUUID(),
      parentCell: structuredClone(anchor.parentCell),
      scenario: { kind: "observation", instanceOccurrenceId: anchor.id },
      retryOf,
      terminalStatus: null,
      // Control observations own their diagnostics, not the child's scenario
      // assertions. Actual attempts retain declarations even when no rows return.
      assertions: options.diagnostic ? null : structuredClone(declarations[index] ?? null),
      launch: structuredClone(launch),
      receipts: [],
    };
    observations.push(occurrence);
    return occurrence.id;
  }

  function observationFor(id: string) {
    const occurrence = observations.find((candidate) => candidate.id === id);
    if (!occurrence) {
      throw new Error(`unknown evidence observation ${id}`);
    }
    return occurrence;
  }

  function complete(
    occurrenceId: string,
    result: {
      status: QaEvidenceStatus;
      entries: readonly QaEvidenceSummaryEntry[];
      receipts?: QaEvidenceOccurrence["receipts"];
      childEvidence?: QaEvidenceSummaryV3Json;
      childCoverage?: QaEvidenceOccurrence["childCoverage"];
    },
  ) {
    const occurrence = observationFor(occurrenceId);
    // Capturing a child freezes even its unfinished observations. Only the
    // original live invocation may complete them, not an enclosing collector.
    if (
      resolveQaEvidenceContainment([...anchors, ...observations], entries).parentById.has(
        occurrenceId,
      )
    ) {
      throw new Error("captured child evidence cannot be completed by its enclosing invocation");
    }
    if (
      occurrence.terminalStatus !== null ||
      entries.some((entry) => entry.binding.occurrenceId === occurrenceId)
    ) {
      throw new Error("an evidence observation can complete only once");
    }
    for (const entry of result.entries) {
      if ("binding" in entry && entry.binding.occurrenceId !== occurrenceId) {
        throw new Error("foreign child evidence must use the parent reconciliation path");
      }
    }
    const child = result.childEvidence
      ? validateQaEvidenceSummaryJson(result.childEvidence)
      : undefined;
    if (child && child.schemaVersion !== 3) {
      throw new Error("retained child bundles require recorded occurrence custody");
    }
    const childOccurrences = child?.occurrences ?? [];
    const existingIds = new Set([...anchors, ...observations].map((item) => item.id));
    if (childOccurrences.some((item) => existingIds.has(item.id))) {
      throw new Error("retained child evidence overlaps an existing attempt");
    }
    const containment = resolveQaEvidenceContainment(childOccurrences, child?.entries ?? []);
    const completed = {
      ...occurrence,
      terminalStatus: result.status,
      receipts: structuredClone(result.receipts ?? []),
      ...(result.childCoverage !== undefined
        ? { childCoverage: structuredClone(result.childCoverage) }
        : {}),
      ...(childOccurrences.length
        ? {
            childOccurrenceIds: childOccurrences
              .filter((item) => !containment.parentById.has(item.id))
              .map((item) => item.id),
          }
        : {}),
    };
    // Validate ownership before admitting any child bytes. Local selection is
    // committed separately by select(), including the enclosing retry's activity.
    resolveQaEvidenceContainment(
      [
        ...anchors,
        ...observations.filter((item) => item.id !== occurrenceId),
        completed,
        ...childOccurrences,
      ],
      [...entries, ...(child?.entries ?? [])],
    );
    Object.assign(occurrence, completed);
    observations.push(...structuredClone(childOccurrences));
    entries.push(...structuredClone(child?.entries ?? []));
    for (const entry of result.entries) {
      entries.push({
        ...structuredClone(entry),
        // A v2 reporter has no assertion/target receipt binding. Do not derive
        // one from its label, coverage set, environment, or package claim.
        binding:
          "binding" in entry
            ? structuredClone(entry.binding)
            : { occurrenceId, assertionId: null, receiptId: null },
        effective: true,
      });
    }
  }

  function select(index: number, occurrenceId: string): string;
  function select(index: number, occurrenceId: null): null;
  function select(index: number, occurrenceId: string | null): string | null {
    anchorFor(index);
    const nextAnchors = structuredClone(anchors);
    const nextObservations = structuredClone(observations);
    const nextEntries = structuredClone(entries);
    const anchor = nextAnchors[index]!;
    const pending = pendingChildren.get(index);
    if (pending) {
      for (const completion of pending.completions) {
        const offset = nextObservations.findIndex((item) => item.id === completion.id);
        nextObservations[offset] = structuredClone(completion);
      }
      for (const update of pending.updates) {
        for (const entry of nextEntries) {
          if (entry.binding.occurrenceId === update.occurrenceId) {
            entry.effective = update.effective;
          }
        }
      }
      nextObservations.splice(pending.observationOffset, 0, ...structuredClone(pending.additions));
      nextEntries.splice(pending.entryOffset, 0, ...structuredClone(pending.rows));
    }
    const byId = new Map(nextObservations.map((occurrence) => [occurrence.id, occurrence]));
    let selected = occurrenceId === null ? null : byId.get(occurrenceId);
    if (
      occurrenceId !== null &&
      (selected?.scenario?.kind !== "observation" ||
        selected.scenario.instanceOccurrenceId !== anchor.id)
    ) {
      throw new Error("cannot select another instance's observation");
    }
    if (
      occurrenceId === null &&
      anchor.scenario?.kind === "instance" &&
      anchor.scenario.resultOccurrenceId !== null
    ) {
      throw new Error("cannot clear an instance's recorded selection");
    }
    while (selected && selected.retryOf !== null && selected.terminalStatus !== "pass") {
      // A nonpassing retry cannot replace the prior failure. Retain both raw
      // attempts while keeping whole-attempt selection with the original owner.
      const previous = byId.get(selected.retryOf);
      if (!previous) {
        throw new Error("unknown retry predecessor");
      }
      selected = previous;
    }
    const selectedId = selected?.id ?? null;
    anchor.scenario = { kind: "instance", resultOccurrenceId: selectedId };
    // Retrying changes whole-attempt selection, never individual assertion rows.
    let priorId = selected?.retryOf ?? null;
    while (priorId !== null) {
      for (const entry of nextEntries) {
        if (entry.binding.occurrenceId === priorId) {
          entry.effective = false;
        }
      }
      priorId = byId.get(priorId)!.retryOf;
    }
    for (const occurrence of nextObservations) {
      let ancestor = occurrence.retryOf;
      while (ancestor !== null && ancestor !== selectedId) {
        ancestor = byId.get(ancestor)!.retryOf;
      }
      if (selectedId !== null && ancestor === selectedId && occurrence.terminalStatus !== "pass") {
        for (const entry of nextEntries) {
          if (entry.binding.occurrenceId === occurrence.id) {
            entry.effective = false;
          }
        }
      }
    }
    // Validate the full proposed selection before changing authoritative state
    // or consuming pending imports; a rejected choice remains retryable by its owner.
    buildQaOccurrenceEvidenceSummary({
      generatedAt: new Date().toISOString(),
      occurrences: [...nextAnchors, ...nextObservations],
      entries: nextEntries,
    });
    anchors.splice(0, anchors.length, ...nextAnchors);
    observations.splice(0, observations.length, ...nextObservations);
    entries.splice(0, entries.length, ...nextEntries);
    pendingChildren.delete(index);
    return selectedId;
  }

  function importChild(index: number, input: QaEvidenceSummaryJson) {
    const child = validateQaEvidenceSummaryJson(input);
    if (child.schemaVersion !== 3) {
      throw new Error("child reconciliation requires recorded v3 invocation custody");
    }
    const anchor = anchorFor(index);
    const containment = resolveQaEvidenceContainment(child.occurrences, child.entries);
    const childAnchor = child.occurrences.find((candidate) => candidate.id === anchor.id);
    if (
      childAnchor?.scenario?.kind !== "instance" ||
      JSON.stringify(childAnchor.parentCell) !== JSON.stringify(anchor.parentCell) ||
      JSON.stringify(childAnchor.launch) !== JSON.stringify(anchor.launch)
    ) {
      throw new Error("child evidence changed its admitted scheduling or launch identity");
    }
    const existing = new Map(observations.map((occurrence) => [occurrence.id, occurrence]));
    const captured = resolveQaEvidenceContainment([...anchors, ...observations], entries);
    const incoming = child.occurrences.filter((occurrence) => occurrence.id !== anchor.id);
    const additions = incoming.filter((occurrence) => !existing.has(occurrence.id));
    const completions: QaEvidenceOccurrence[] = [];
    const immutableObservation = ({
      terminalStatus: _status,
      receipts: _receipts,
      childOccurrenceIds: _children,
      childCoverage: _coverage,
      ...identity
    }: QaEvidenceOccurrence) => identity;
    for (const occurrence of incoming) {
      const previous = existing.get(occurrence.id);
      if (!previous || JSON.stringify(previous) === JSON.stringify(occurrence)) {
        continue;
      }
      // Only the admitted child may finish its open observation. Completed
      // identities, rows and receipts are never rewritten by later snapshots.
      if (
        captured.parentById.has(occurrence.id) ||
        previous.terminalStatus !== null ||
        occurrence.terminalStatus === null ||
        JSON.stringify(immutableObservation(previous)) !==
          JSON.stringify(immutableObservation(occurrence)) ||
        JSON.stringify(occurrence.receipts.slice(0, previous.receipts.length)) !==
          JSON.stringify(previous.receipts) ||
        entries.some((entry) => entry.binding.occurrenceId === occurrence.id)
      ) {
        throw new Error("child evidence changed a completed or immutable observation");
      }
      completions.push(occurrence);
    }
    if (
      incoming.some(
        (occurrence) =>
          (!containment.parentById.has(occurrence.id) &&
            (occurrence.scenario?.kind !== "observation" ||
              occurrence.scenario.instanceOccurrenceId !== anchor.id ||
              JSON.stringify(occurrence.launch) !== JSON.stringify(launch))) ||
          anchors.some((candidate) => candidate.id === occurrence.id) ||
          (existing.has(occurrence.id) &&
            !completions.includes(occurrence) &&
            JSON.stringify(existing.get(occurrence.id)) !== JSON.stringify(occurrence)),
      )
    ) {
      throw new Error("child evidence contains a foreign or repeated observation");
    }
    // Continuations may change only effective selection on already captured
    // rows. Their assertions, results, bindings and artifacts remain immutable.
    const effectiveUpdates: Array<{ occurrenceId: string; effective: boolean }> = [];
    for (const [id] of existing) {
      if (completions.some((occurrence) => occurrence.id === id)) {
        continue;
      }
      const previousRows = entries.filter((entry) => entry.binding.occurrenceId === id);
      if (!incoming.some((occurrence) => occurrence.id === id)) {
        continue;
      }
      const nextRows = child.entries.filter((entry) => entry.binding.occurrenceId === id);
      const immutable = (rows: typeof previousRows) =>
        rows.map(({ effective: _effective, ...row }) => row);
      if (JSON.stringify(immutable(previousRows)) !== JSON.stringify(immutable(nextRows))) {
        throw new Error("child evidence changed an existing observation's rows");
      }
      if (
        captured.parentById.has(id) &&
        JSON.stringify(previousRows) !== JSON.stringify(nextRows)
      ) {
        throw new Error("child evidence changed retained bundle selection");
      }
      if (nextRows.length > 0) {
        effectiveUpdates.push({ occurrenceId: id, effective: nextRows[0]!.effective });
      }
    }
    const addedIds = new Set([...additions, ...completions].map((occurrence) => occurrence.id));
    if (addedIds.size > 0) {
      // Import is a proposal until the parent selects an actual result. Applying
      // child retry flags earlier would invalidate the parent's selected failure.
      const proposed = {
        observationOffset: observations.length,
        entryOffset: entries.length,
        additions: structuredClone(additions),
        completions: structuredClone(completions),
        rows: structuredClone(
          child.entries.filter((entry) => addedIds.has(entry.binding.occurrenceId)),
        ),
        updates: effectiveUpdates,
      };
      const pending = pendingChildren.get(index);
      if (pending) {
        if (
          JSON.stringify([
            pending.additions,
            pending.completions,
            pending.rows,
            pending.updates,
          ]) !==
          JSON.stringify([
            proposed.additions,
            proposed.completions,
            proposed.rows,
            proposed.updates,
          ])
        ) {
          throw new Error("child evidence changed its pending observation");
        }
      } else {
        pendingChildren.set(index, proposed);
      }
    }
    // The caller, which owns the actual returned result, explicitly selects.
    return childAnchor.scenario.resultOccurrenceId;
  }

  function snapshot(options: {
    generatedAt: string;
    evidenceMode?: QaScorecardEvidenceMode;
    profile?: string;
  }) {
    return buildQaOccurrenceEvidenceSummary({
      ...options,
      entries,
      occurrences: [...anchors, ...observations],
    });
  }

  function childInput(index: number) {
    const anchor = anchorFor(index);
    const containment = resolveQaEvidenceContainment([...anchors, ...observations], entries);
    const ownedIds = new Set(
      observations
        .filter(
          (occurrence) =>
            occurrence.scenario?.kind === "observation" &&
            occurrence.scenario.instanceOccurrenceId === anchor.id,
        )
        .map((occurrence) => occurrence.id),
    );
    const childObservations = observations.filter((occurrence) =>
      ownedIds.has(containment.rootId(occurrence.id)),
    );
    const ids = new Set(childObservations.map((occurrence) => occurrence.id));
    return buildQaOccurrenceEvidenceSummary({
      generatedAt: new Date().toISOString(),
      occurrences: [anchor, ...childObservations],
      entries: entries.filter((entry) => ids.has(entry.binding.occurrenceId)),
    });
  }

  return {
    get anchors() {
      return structuredClone(anchors);
    },
    begin,
    complete,
    select,
    previousFailure,
    selectedObservation(index: number) {
      const anchor = anchorFor(index);
      const id = anchor.scenario?.kind === "instance" ? anchor.scenario.resultOccurrenceId : null;
      return id === null
        ? null
        : {
            occurrence: structuredClone(observationFor(id)),
            entries: structuredClone(entries.filter((entry) => entry.binding.occurrenceId === id)),
          };
    },
    childInput,
    importChild,
    snapshot,
  };
}
