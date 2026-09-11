import { performance } from "node:perf_hooks";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { projectClassifierInput } from "./input.ts";
import type {
  Candidate,
  ClassifierInput,
  ClassifierObservation,
  ClassifierRoute,
  Coverage,
  DecisionFixture,
  DecisionRecord,
  ExperimentReport,
  HostState,
  Preview,
  RouteReport,
} from "./types.ts";

export type * from "./types.ts";

const candidateSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "activityId", "direction"],
      properties: {
        kind: { const: "directive" },
        activityId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        direction: { enum: ["A", "B"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { enum: ["none", "clarify", "stop"] } },
    },
  ],
};

/** The classifier sees neither permissions, destinations, gold answers nor other candidates. */
function buildClassifierInput(message: string, host: HostState): ClassifierInput {
  return projectClassifierInput({ message, activities: host.activities });
}

/** Deliberately tiny experiment grammar, not general natural-language decision discovery. */
function explicitSelection(input: ClassifierInput): Candidate {
  if (/^stop(?:[\s.,!;:]|$)/i.test(input.message.trim())) {
    return { kind: "stop" };
  }
  const match = /^(?:please\s+)?use\s+([AB])\s+for\s+([a-z][a-z0-9 -]{0,63})[.!]?$/i.exec(
    input.message.trim(),
  );
  if (!match) {
    return { kind: "none" };
  }
  const [, direction, rawLabel] = match;
  if (!direction || !rawLabel) {
    return { kind: "none" };
  }
  const label = rawLabel.trim().toLowerCase();
  const matches = input.activities.filter((activity) => activity.label.toLowerCase() === label);
  const activity = matches[0];
  if (matches.length !== 1 || !activity) {
    return { kind: "clarify" };
  }
  return {
    kind: "directive",
    activityId: activity.id,
    direction: direction.toUpperCase() === "A" ? "A" : "B",
  };
}

function parseCandidate(text: string | undefined): Candidate | null {
  if (text === undefined || text.length > 2048) {
    return null;
  }
  try {
    const checked = validateJsonSchemaValue({
      schema: candidateSchema,
      cacheKey: "scoped-decision-experiment-candidate-v1",
      value: JSON.parse(text) as unknown,
    });
    return checked.ok ? (checked.value as Candidate) : null;
  } catch {
    return null;
  }
}

export function explicitCommandRoute(): ClassifierRoute {
  return {
    name: "explicit-command",
    kind: "deterministic",
    classify: async (input) => ({
      text: JSON.stringify(explicitSelection(input)),
      modelCalls: 0,
      physicalProviderRequests: 0,
    }),
  };
}

export function replayRoute(name: string, text: string): ClassifierRoute {
  return {
    name,
    kind: "replay",
    classify: async () => ({ text, modelCalls: 0, physicalProviderRequests: 0 }),
  };
}

function sameDirective(a: Candidate, b: Candidate): boolean {
  return (
    a.kind === "directive" &&
    b.kind === "directive" &&
    a.activityId === b.activityId &&
    a.direction === b.direction
  );
}

function reviewCandidate(params: {
  selection: Candidate;
  candidate: Candidate | null;
  initial: HostState;
  current: HostState;
}): { gate: DecisionRecord["gate"]; preview: Preview | null } {
  const { selection, candidate, initial, current } = params;
  const result = (outcome: DecisionRecord["gate"]["outcome"], reason: string) => ({
    gate: { outcome, reason },
    preview: null,
  });
  if (!candidate) {
    return result("blocked", "candidate-malformed");
  }
  if (candidate.kind === "none") {
    return result("abstained", "no-directive-proposed");
  }
  if (candidate.kind !== "directive") {
    return result("needs-clarification", "candidate-requires-owner-input");
  }
  if (selection.kind !== "directive") {
    return result("needs-clarification", "instruction-not-explicitly-scoped");
  }
  if (!sameDirective(selection, candidate)) {
    return result("blocked", "candidate-does-not-match-instruction");
  }
  const original = initial.activities.find((activity) => activity.id === selection.activityId);
  const activity = current.activities.find((entry) => entry.id === selection.activityId);
  if (
    initial.actorId !== current.actorId ||
    initial.sourceId !== current.sourceId ||
    !original ||
    !activity ||
    original.destinationId !== activity.destinationId ||
    original.label !== activity.label
  ) {
    return result("blocked", "host-binding-changed");
  }
  if (!current.decisionGrants.includes(activity.id)) {
    return result("blocked", "decision-authority-denied");
  }
  const releases = current.releases.filter(
    (policy) =>
      policy.sourceId === current.sourceId &&
      policy.activityId === activity.id &&
      policy.destinationId === activity.destinationId &&
      policy.directions.includes(candidate.direction),
  );
  // This small experiment supports exactly one unambiguous source-owned release rule.
  const release = releases[0];
  if (releases.length !== 1 || !release || !release.allowed || !release.importAllowed) {
    return result("blocked", "disclosure-denied-or-ambiguous");
  }
  const preview: Preview = {
    activityId: activity.id,
    destinationId: activity.destinationId,
    policyId: release.id,
    payload: { kind: "direction-update", activityId: activity.id, direction: candidate.direction },
    text: "Use " + candidate.direction + " for " + activity.id + ".",
  };
  return {
    gate: { outcome: "authorization-preview", reason: "explicit-authorized-directive" },
    preview,
  };
}

function observedNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function runCase(params: {
  id: string;
  message: string;
  host: () => HostState;
  route: ClassifierRoute;
}): Promise<DecisionRecord> {
  const started = performance.now();
  const record: DecisionRecord = {
    id: params.id,
    candidate: null,
    gate: { outcome: "blocked", reason: "host-state-unavailable" },
    preview: null,
    metrics: {
      classifierInvocations: 0,
      modelCalls: 0,
      physicalProviderRequests: 0,
      usage: null,
      classifierWallMs: 0,
      preparationMs: null,
      completionMs: null,
      validationMs: 0,
      totalMs: 0,
      inlineModelOverhead: null,
    },
  };
  try {
    const initial = structuredClone(params.host());
    const input = buildClassifierInput(params.message, initial);
    const selection = explicitSelection(input);
    if (selection.kind === "stop") {
      record.candidate = selection;
      record.gate = { outcome: "stop-observed", reason: "actual-interrupt-not-implemented" };
      return record;
    }
    const classifierStarted = performance.now();
    record.metrics.classifierInvocations = 1;
    let observation: ClassifierObservation;
    try {
      observation = await params.route.classify(structuredClone(input));
    } catch {
      record.metrics.modelCalls = params.route.kind === "separate-completion" ? null : 0;
      record.metrics.physicalProviderRequests =
        params.route.kind === "separate-completion" ? null : 0;
      record.gate = { outcome: "classifier-error", reason: "classifier-failed" };
      return record;
    } finally {
      record.metrics.classifierWallMs = performance.now() - classifierStarted;
    }
    record.metrics.modelCalls = observedNumber(observation.modelCalls);
    record.metrics.physicalProviderRequests = observedNumber(observation.physicalProviderRequests);
    record.metrics.usage = observation.usage ?? null;
    record.metrics.preparationMs = observedNumber(observation.preparationMs);
    record.metrics.completionMs = observedNumber(observation.completionMs);
    if (observation.error) {
      record.gate = { outcome: "classifier-error", reason: "classifier-failed" };
      return record;
    }
    const validationStarted = performance.now();
    try {
      record.candidate = parseCandidate(observation.text);
      const current = structuredClone(params.host());
      // Validate current identities too; no cached authority across an awaited classification.
      buildClassifierInput(params.message, current);
      const reviewed = reviewCandidate({
        selection,
        candidate: record.candidate,
        initial,
        current,
      });
      record.gate = reviewed.gate;
      record.preview = reviewed.preview;
    } finally {
      record.metrics.validationMs = performance.now() - validationStarted;
    }
    return record;
  } catch {
    record.gate = { outcome: "blocked", reason: "invalid-or-unavailable-host-input" };
    return record;
  } finally {
    record.metrics.totalMs = performance.now() - started;
  }
}

function coverage(values: (number | null | undefined)[]): Coverage {
  const observed = values.map(observedNumber).filter((value): value is number => value !== null);
  return {
    knownTotal: observed.reduce((sum, value) => sum + value, 0),
    observedSamples: observed.length,
    totalSamples: values.length,
  };
}

function summarize(
  route: Pick<ClassifierRoute, "name" | "kind">,
  records: DecisionRecord[],
  fixtures: readonly DecisionFixture[],
): RouteReport {
  let rawClassificationErrors = 0;
  let rawTargetErrors = 0;
  let unsafePreviews = 0;
  let missedPreviews = 0;
  for (const [index, record] of records.entries()) {
    const fixture = fixtures[index];
    if (!fixture) {
      throw new Error("Missing expected result for an experiment record.");
    }
    const expected = fixture.expected;
    if (record.candidate?.kind !== expected.kind) {
      rawClassificationErrors += 1;
    }
    const targetMatches =
      expected.activityId === undefined ||
      (record.candidate?.kind === "directive" &&
        record.candidate.activityId === expected.activityId &&
        record.candidate.direction === expected.direction);
    if (!targetMatches) {
      rawTargetErrors += 1;
    }
    if (record.preview !== null && (!expected.previews || !targetMatches)) {
      unsafePreviews += 1;
    }
    if (record.preview === null && expected.previews) {
      missedPreviews += 1;
    }
  }
  return {
    route: route.name,
    kind: route.kind,
    records,
    metrics: {
      modelCalls: coverage(records.map((record) => record.metrics.modelCalls)),
      physicalProviderRequests: coverage(
        records.map((record) => record.metrics.physicalProviderRequests),
      ),
      usage: {
        inputTokens: coverage(records.map((record) => record.metrics.usage?.inputTokens)),
        outputTokens: coverage(records.map((record) => record.metrics.usage?.outputTokens)),
        totalTokens: coverage(records.map((record) => record.metrics.usage?.totalTokens)),
      },
      classifierWallMs: records.reduce((sum, record) => sum + record.metrics.classifierWallMs, 0),
      validationMs: records.reduce((sum, record) => sum + record.metrics.validationMs, 0),
      totalMs: records.reduce((sum, record) => sum + record.metrics.totalMs, 0),
      rawClassificationErrors,
      rawTargetErrors,
      unsafePreviews,
      missedPreviews,
      authorizationPreviews: records.filter((record) => record.preview !== null).length,
      classifierErrors: records.filter((record) => record.gate.outcome === "classifier-error")
        .length,
    },
  };
}

export async function runExperiment(
  fixtures: readonly DecisionFixture[],
  routes?: readonly ClassifierRoute[],
): Promise<ExperimentReport> {
  const reports: RouteReport[] = [];
  if (routes) {
    for (const route of routes) {
      const records: DecisionRecord[] = [];
      for (const fixture of fixtures) {
        records.push(await runCase({ ...fixture, host: () => fixture.host, route }));
      }
      reports.push(summarize(route, records, fixtures));
    }
  } else {
    const baseline = await runExperiment(fixtures, [explicitCommandRoute()]);
    reports.push(...baseline.routes);
    const records: DecisionRecord[] = [];
    for (const fixture of fixtures) {
      records.push(
        await runCase({
          ...fixture,
          host: () => fixture.host,
          route: replayRoute("inline-candidate-replay", fixture.replay),
        }),
      );
    }
    reports.push(summarize({ name: "inline-candidate-replay", kind: "replay" }, records, fixtures));
  }
  return {
    schema: "scoped-decision-experiment-v1",
    effect: "authorization-preview-only",
    routes: reports,
  };
}
