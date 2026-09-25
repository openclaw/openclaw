// Canonical v2/v3 evidence shapes and occurrence binding validation.
import { z } from "zod";
import { qaEvidenceAssertionSchema, qaEvidenceCoverageSchema } from "./evidence-assertion.js";
import { qaRuntimePairLaneSchema } from "./scenario-catalog.js";
import {
  qaMaturityTaxonomyIdentitySchema,
  qaProofRequirementsSchema,
  qaScorecardEvidenceModeSchema,
} from "./scorecard-taxonomy.js";

export const QA_EVIDENCE_SUMMARY_KIND = "openclaw.qa.evidence-summary";
export const QA_EVIDENCE_FILENAME = "qa-evidence.json";
// Existing producers and historical artifacts retain their exact v2 contract.
// Only a producer with recorded invocation custody may construct v3.
const QA_EVIDENCE_SUMMARY_SCHEMA_VERSION = 2;

const qaEvidenceStatusSchema = z.enum(["pass", "fail", "blocked", "skipped"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const nullableStringSchema = nonEmptyStringSchema.nullable();
const qaEvidenceProfileIdSchema = nonEmptyStringSchema;

const qaEvidenceCellSchema = z.strictObject({
  scenarioId: nonEmptyStringSchema,
  executionKind: z.enum(["flow", "script", "vitest", "playwright"]),
  channel: nullableStringSchema,
});

export const QA_PROFILE_EVIDENCE_PLAN_LIST_NAMES = [
  "membership",
  "selected",
  "excluded",
  "expectedCells",
  "observedCells",
  "missingCells",
] as const;
type ListName = (typeof QA_PROFILE_EVIDENCE_PLAN_LIST_NAMES)[number];
const planShape = z.strictObject({
  profile: nonEmptyStringSchema,
  membership: z.array(nonEmptyStringSchema),
  selected: z.array(nonEmptyStringSchema),
  excluded: z.array(
    z.strictObject({
      scenarioId: nonEmptyStringSchema,
      reasons: z.array(nonEmptyStringSchema).min(1),
    }),
  ),
  expectedCells: z.array(qaEvidenceCellSchema),
  observedCells: z.array(qaEvidenceCellSchema),
  missingCells: z.array(qaEvidenceCellSchema),
  counts: z.record(z.enum(QA_PROFILE_EVIDENCE_PLAN_LIST_NAMES), z.number().int().nonnegative()),
  // Historical plans retain their original serialized bytes and attestation digest.
  taxonomyIdentity: qaMaturityTaxonomyIdentitySchema.optional(),
  proofRequirements: qaProofRequirementsSchema.optional(),
});

type PlanShape = z.infer<typeof planShape>;

export function qaProfileEvidencePlanCellKey(cell: z.infer<typeof qaEvidenceCellSchema>) {
  return `${cell.scenarioId}\u0000${cell.executionKind}\u0000${cell.channel ?? ""}`;
}

function assertCanonical(name: string, values: readonly string[]) {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    throw new Error(`${name} must be unique and sorted`);
  }
}

function assertSame(message: string, left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(message);
  }
}

function planLists(plan: PlanShape): Record<ListName, string[]> {
  return {
    membership: plan.membership,
    selected: plan.selected,
    excluded: plan.excluded.map((entry) => entry.scenarioId),
    expectedCells: plan.expectedCells.map(qaProfileEvidencePlanCellKey),
    observedCells: plan.observedCells.map(qaProfileEvidencePlanCellKey),
    missingCells: plan.missingCells.map(qaProfileEvidencePlanCellKey),
  };
}

function assertPlanInvariants(plan: PlanShape) {
  const lists = planLists(plan);
  for (const name of QA_PROFILE_EVIDENCE_PLAN_LIST_NAMES) {
    assertCanonical(name, lists[name]);
    if (plan.counts[name] !== lists[name].length) {
      throw new Error(`counts.${name} must equal ${lists[name].length}`);
    }
  }
  for (const exclusion of plan.excluded) {
    assertCanonical(`exclusion reasons for ${exclusion.scenarioId}`, exclusion.reasons);
  }
  assertSame(
    "selected and excluded scenarios must exactly partition membership",
    lists.membership,
    [...lists.selected, ...lists.excluded].toSorted(),
  );
  assertSame(
    "expected cells must exactly cover selected scenarios",
    lists.selected,
    [...new Set(plan.expectedCells.map((cell) => cell.scenarioId))].toSorted(),
  );
  const expected = new Set(lists.expectedCells);
  const observed = new Set(lists.observedCells);
  if (lists.observedCells.some((cell) => !expected.has(cell))) {
    throw new Error("unexpected execution cells invalidate evidence");
  }
  assertSame(
    "missing cells must equal expected minus observed",
    lists.missingCells,
    lists.expectedCells.filter((cell) => !observed.has(cell)),
  );
}

export const qaProfileEvidencePlanSchema = planShape.superRefine((plan, context) => {
  try {
    assertPlanInvariants(plan);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export type QaProfileEvidencePlan = z.infer<typeof qaProfileEvidencePlanSchema>;

const qaEvidenceProviderSchema = z.strictObject({
  id: nonEmptyStringSchema,
  live: z.boolean(),
  model: z.strictObject({
    name: nullableStringSchema,
    ref: nullableStringSchema,
  }),
  fixture: nonEmptyStringSchema.optional(),
  auth: nonEmptyStringSchema.optional(),
});

const qaEvidenceChannelSchema = z.strictObject({
  id: nonEmptyStringSchema,
  live: z.boolean(),
  driver: nonEmptyStringSchema.optional(),
});

const qaEvidenceEnvironmentSchema = z.strictObject({
  ref: nullableStringSchema,
  os: nonEmptyStringSchema,
  nodeVersion: nonEmptyStringSchema,
});

const qaEvidencePackageSourceSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  spec: nonEmptyStringSchema.optional(),
  sha: nonEmptyStringSchema.optional(),
});

const qaEvidenceFailureSchema = z.strictObject({
  class: nonEmptyStringSchema.optional(),
  reason: nonEmptyStringSchema,
});

const qaEvidenceTimingSchema = z.strictObject({
  wallMs: z.number().finite().positive().optional(),
  rttMs: z.number().finite().positive().optional(),
  avgMs: z.number().finite().positive().optional(),
  p50Ms: z.number().finite().positive().optional(),
  p95Ms: z.number().finite().positive().optional(),
  maxMs: z.number().finite().positive().optional(),
  samples: z.number().int().positive().optional(),
  failedSamples: z.number().int().nonnegative().optional(),
});

const qaEvidenceRttMeasurementSchema = z.strictObject({
  finalMatchedReplyRttMs: z.number().finite().positive(),
  requestStartedAt: nonEmptyStringSchema,
  responseObservedAt: nonEmptyStringSchema,
  source: nonEmptyStringSchema,
});

const qaEvidenceTestSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  source: z
    .strictObject({
      path: nonEmptyStringSchema,
    })
    .optional(),
});

const qaEvidenceRefSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
});

const qaEvidenceScorecardCountSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  fulfilled: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative().optional(),
  missing: z.number().int().nonnegative(),
  fulfillmentPercent: z.number().finite().nonnegative(),
});

const qaEvidenceScorecardCoverageCountSchema = qaEvidenceScorecardCountSchema.extend({
  secondaryOnly: z.number().int().nonnegative(),
});

const qaEvidenceScorecardCategorySchema = z.strictObject({
  id: nonEmptyStringSchema,
  surfaceId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  status: z.enum(["fulfilled", "partial", "missing"]),
  features: qaEvidenceScorecardCountSchema,
  coverageIds: qaEvidenceScorecardCoverageCountSchema,
  missingCoverageIds: z.array(nonEmptyStringSchema),
});

const qaEvidenceScorecardSchema = z.strictObject({
  filters: z.strictObject({
    surface: nullableStringSchema,
    category: nullableStringSchema,
  }),
  run: z.strictObject({
    evidenceEntryCount: z.number().int().nonnegative(),
  }),
  categories: qaEvidenceScorecardCountSchema,
  features: qaEvidenceScorecardCountSchema,
  coverageIds: qaEvidenceScorecardCountSchema,
  categoryReports: z.array(qaEvidenceScorecardCategorySchema),
});

const qaEvidenceArtifactSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  source: nonEmptyStringSchema,
});

const qaEvidenceExecutionSchema = z.strictObject({
  runner: nonEmptyStringSchema,
  environment: qaEvidenceEnvironmentSchema,
  provider: qaEvidenceProviderSchema,
  channel: qaEvidenceChannelSchema.optional(),
  packageSource: qaEvidencePackageSourceSchema,
  artifacts: z.array(qaEvidenceArtifactSchema),
});

const qaEvidenceResultSchema = z.strictObject({
  status: qaEvidenceStatusSchema,
  failure: qaEvidenceFailureSchema.optional(),
  timing: qaEvidenceTimingSchema.optional(),
  rttMeasurement: qaEvidenceRttMeasurementSchema.optional(),
});

const qaEvidencePostureSchema = z.enum(["direct-gateway", "native-approval", "user-path"]);

const qaEvidenceSummaryEntrySchema = z.strictObject({
  test: qaEvidenceTestSchema,
  coverage: z.array(qaEvidenceCoverageSchema),
  posture: qaEvidencePostureSchema.optional(),
  refs: z.array(qaEvidenceRefSchema).optional(),
  runtimePairLane: qaRuntimePairLaneSchema.optional(),
  execution: qaEvidenceExecutionSchema.optional(),
  result: qaEvidenceResultSchema,
});

const qaEvidenceSummarySchema = z.strictObject({
  kind: z.literal(QA_EVIDENCE_SUMMARY_KIND),
  schemaVersion: z.literal(QA_EVIDENCE_SUMMARY_SCHEMA_VERSION),
  generatedAt: nonEmptyStringSchema,
  evidenceMode: qaScorecardEvidenceModeSchema,
  entries: z.array(qaEvidenceSummaryEntrySchema),
  profile: qaEvidenceProfileIdSchema.optional(),
  profilePlan: qaProfileEvidencePlanSchema.optional(),
  scorecard: qaEvidenceScorecardSchema.optional(),
});

const qaEvidenceIdentitySchema = z.strictObject({
  source: z.strictObject({ ref: nullableStringSchema, integrity: nullableStringSchema }),
  runtime: z.strictObject({ id: nullableStringSchema, version: nullableStringSchema }),
  package: z
    .strictObject({
      kind: nonEmptyStringSchema,
      spec: nullableStringSchema,
      version: nullableStringSchema,
      integrity: nullableStringSchema,
    })
    .nullable(),
  protocol: nullableStringSchema,
  accountRef: nullableStringSchema,
  proofClass: z
    .enum([
      "fixture-only",
      "real-plugin/local-protocol",
      "native-host",
      "packaged-install/upgrade",
      "live-channel",
      "live-provider",
    ])
    .nullable(),
});

const qaEvidenceOccurrenceSchema = z.strictObject({
  id: nonEmptyStringSchema,
  parentCell: qaEvidenceCellSchema.nullable(),
  scenario: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("instance"),
        resultOccurrenceId: nullableStringSchema,
      }),
      z.strictObject({
        kind: z.literal("observation"),
        instanceOccurrenceId: nonEmptyStringSchema,
      }),
    ])
    .nullable(),
  retryOf: nullableStringSchema,
  terminalStatus: qaEvidenceStatusSchema.nullable(),
  // A missing declaration is unknown, not an empty successful assertion set.
  assertions: z.array(qaEvidenceAssertionSchema).nullable(),
  launch: qaEvidenceIdentitySchema,
  // Direct members of a retained producer bundle; nested ownership stays local.
  childOccurrenceIds: z.array(nonEmptyStringSchema).min(1).optional(),
  // The enclosing catalog caps qualifying claims without rewriting captured rows.
  childCoverage: z.array(qaEvidenceCoverageSchema).optional(),
  // Reporter metadata cannot stand in for a prepared or target-observed identity.
  receipts: z.array(
    z.strictObject({
      id: nonEmptyStringSchema,
      phase: z.enum(["prepared", "installed", "runtime"]),
      identity: qaEvidenceIdentitySchema,
      artifact: qaEvidenceArtifactSchema.extend({
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    }),
  ),
});

const qaEvidenceSummaryV3EntrySchema = qaEvidenceSummaryEntrySchema.extend({
  binding: z.strictObject({
    occurrenceId: nonEmptyStringSchema,
    assertionId: nullableStringSchema,
    receiptId: nullableStringSchema,
  }),
  effective: z.boolean(),
});

const qaEvidenceSummaryV3Shape = qaEvidenceSummarySchema.extend({
  schemaVersion: z.literal(3),
  entries: z.array(qaEvidenceSummaryV3EntrySchema),
  occurrences: z.array(qaEvidenceOccurrenceSchema),
});

/** Direct bundle membership preserves child-local selection across outer retries. */
export function resolveQaEvidenceContainment(
  occurrences: readonly QaEvidenceOccurrence[],
  entries: readonly QaEvidenceSummaryV3Entry[],
) {
  const byId = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const parentById = new Map<string, string>();
  const localActivity = new Map(
    entries.map((entry) => [entry.binding.occurrenceId, entry.effective]),
  );
  for (const owner of occurrences) {
    if (owner.childCoverage !== undefined && !owner.childOccurrenceIds) {
      throw new Error("child coverage requires captured bundle membership");
    }
    if (!owner.childOccurrenceIds) {
      continue;
    }
    const bundleReceipts = owner.receipts.filter(
      (receipt) => receipt.artifact.kind === "producer-evidence",
    );
    if (
      owner.scenario?.kind !== "observation" ||
      owner.terminalStatus === null ||
      bundleReceipts.length !== 1 ||
      bundleReceipts[0]!.phase !== "prepared"
    ) {
      throw new Error("child evidence requires a completed command and captured bundle receipt");
    }
    for (const id of owner.childOccurrenceIds) {
      if (id === owner.id || !byId.has(id) || parentById.has(id)) {
        throw new Error("child evidence membership is missing, repeated, or conflicting");
      }
      parentById.set(id, owner.id);
    }
  }
  for (const occurrence of occurrences) {
    const references = [
      occurrence.retryOf,
      occurrence.scenario?.kind === "observation"
        ? occurrence.scenario.instanceOccurrenceId
        : occurrence.scenario?.resultOccurrenceId,
    ];
    if (references.some((id) => id && parentById.get(id) !== parentById.get(occurrence.id))) {
      throw new Error("child evidence membership must contain complete local ownership");
    }
    const visited = new Set([occurrence.id]);
    let parent = parentById.get(occurrence.id);
    while (parent) {
      if (visited.has(parent)) {
        throw new Error("cyclic child evidence membership");
      }
      visited.add(parent);
      parent = parentById.get(parent);
    }
  }
  function rootId(id: string) {
    let root = id;
    let parent = parentById.get(root);
    while (parent) {
      root = parent;
      parent = parentById.get(root);
    }
    return root;
  }
  function isActive(id: string) {
    let parent = parentById.get(id);
    while (parent) {
      // Bundle owners always publish a command row. Missing rows cannot make
      // retained child detail count as a successful enclosing attempt.
      if (localActivity.get(parent) !== true) {
        return false;
      }
      parent = parentById.get(parent);
    }
    return true;
  }
  function projectCoverage(id: string, claims: QaEvidenceSummaryV3Entry["coverage"]) {
    let coverage = claims;
    let parent = parentById.get(id);
    while (parent) {
      const cap = byId.get(parent)!.childCoverage;
      if (cap !== undefined) {
        const allowed = new Set(cap.map((claim) => claim.id));
        const primary = new Set(
          cap.filter((claim) => claim.role === "primary").map((claim) => claim.id),
        );
        coverage = coverage
          .filter((claim) => allowed.has(claim.id))
          .map((claim) =>
            claim.role === "primary" && !primary.has(claim.id)
              ? { id: claim.id, role: "secondary" }
              : claim,
          );
      }
      parent = parentById.get(parent);
    }
    return coverage;
  }
  const rootInstances = occurrences.filter(
    (occurrence) => occurrence.scenario?.kind === "instance" && !parentById.has(occurrence.id),
  );
  return { parentById, rootId, isActive, projectCoverage, rootInstances };
}

function validateOccurrenceBindings(summary: z.infer<typeof qaEvidenceSummaryV3Shape>) {
  const occurrences = new Map<string, QaEvidenceOccurrence>();
  const entries = new Map<string, QaEvidenceSummaryV3Entry[]>();
  const successors = new Map<string, string>();
  for (const occurrence of summary.occurrences) {
    if (occurrences.has(occurrence.id)) {
      throw new Error(`duplicate evidence occurrence ${occurrence.id}`);
    }
    occurrences.set(occurrence.id, occurrence);
    if (
      new Set(occurrence.assertions?.map((assertion) => assertion.id)).size !==
      (occurrence.assertions?.length ?? 0)
    ) {
      throw new Error(`duplicate assertion declaration in ${occurrence.id}`);
    }
    if (
      new Set(occurrence.receipts.map((receipt) => receipt.id)).size !== occurrence.receipts.length
    ) {
      throw new Error(`duplicate target receipt in ${occurrence.id}`);
    }
    if ((occurrence.scenario === null) !== (occurrence.parentCell === null)) {
      throw new Error(`scenario ownership missing in ${occurrence.id}`);
    }
  }
  for (const entry of summary.entries) {
    const occurrence = occurrences.get(entry.binding.occurrenceId);
    if (!occurrence || occurrence.scenario?.kind === "instance") {
      throw new Error("evidence entries must bind to an observation, never a scheduling anchor");
    }
    if (
      entry.binding.receiptId !== null &&
      !occurrence.receipts.some((receipt) => receipt.id === entry.binding.receiptId)
    ) {
      throw new Error(`unknown target receipt in ${occurrence.id}`);
    }
    if (entry.binding.assertionId !== null) {
      const assertion = occurrence.assertions?.find(
        (candidate) => candidate.id === entry.binding.assertionId,
      );
      if (
        !assertion ||
        entry.coverage.some(
          (coverage) =>
            !assertion.coverage.some(
              (allowed) => allowed.id === coverage.id && allowed.role === coverage.role,
            ),
        )
      ) {
        throw new Error(`assertion binding exceeds captured declaration in ${occurrence.id}`);
      }
    }
    const prior = entries.get(occurrence.id) ?? [];
    if (prior.length > 0 && prior[0]!.effective !== entry.effective) {
      throw new Error(`mixed effective rows in ${occurrence.id}`);
    }
    prior.push(entry);
    entries.set(occurrence.id, prior);
  }
  for (const occurrence of summary.occurrences) {
    if (occurrence.scenario?.kind === "instance") {
      if (occurrence.retryOf !== null || occurrence.terminalStatus !== null) {
        throw new Error("scheduling anchors do not record terminal outcomes or retries");
      }
      const selectedId = occurrence.scenario.resultOccurrenceId;
      if (selectedId !== null) {
        const selected = occurrences.get(selectedId);
        if (
          selected?.scenario?.kind !== "observation" ||
          selected.scenario.instanceOccurrenceId !== occurrence.id
        ) {
          throw new Error(`invalid selected observation for ${occurrence.id}`);
        }
        if (entries.get(selectedId)?.some((entry) => !entry.effective)) {
          throw new Error(`selected observation is ineffective for ${occurrence.id}`);
        }
      }
    } else if (occurrence.scenario?.kind === "observation") {
      const anchor = occurrences.get(occurrence.scenario.instanceOccurrenceId);
      if (
        anchor?.scenario?.kind !== "instance" ||
        JSON.stringify(anchor.parentCell) !== JSON.stringify(occurrence.parentCell)
      ) {
        throw new Error(`cross-instance observation ${occurrence.id}`);
      }
    }
    if (occurrence.retryOf !== null) {
      const previous = occurrences.get(occurrence.retryOf);
      if (
        !previous ||
        previous.scenario?.kind === "instance" ||
        JSON.stringify(previous.parentCell) !== JSON.stringify(occurrence.parentCell) ||
        JSON.stringify(previous.scenario) !== JSON.stringify(occurrence.scenario) ||
        successors.has(previous.id)
      ) {
        throw new Error(`invalid retry predecessor for ${occurrence.id}`);
      }
      successors.set(previous.id, occurrence.id);
    }
  }
  for (const occurrence of summary.occurrences) {
    const visited = new Set<string>();
    let current: QaEvidenceOccurrence | undefined = occurrence;
    let effectiveCount = 0;
    while (current) {
      if (visited.has(current.id)) {
        throw new Error(`cyclic retry chain in ${occurrence.id}`);
      }
      visited.add(current.id);
      effectiveCount += entries.get(current.id)?.[0]?.effective ? 1 : 0;
      current = current.retryOf === null ? undefined : occurrences.get(current.retryOf);
    }
    if (effectiveCount > 1) {
      throw new Error("multiple effective attempts in one retry chain");
    }
  }
  // Selection is whole-attempt: a nonpassing retry never replaces its predecessor.
  for (const occurrence of summary.occurrences) {
    const nextId = successors.get(occurrence.id);
    if (!nextId) {
      continue;
    }
    const next = occurrences.get(nextId)!;
    const currentEffective = entries.get(occurrence.id)?.[0]?.effective;
    const nextEffective = entries.get(next.id)?.[0]?.effective;
    if (currentEffective && nextEffective) {
      throw new Error("multiple effective attempts in one retry chain");
    }
    if (
      occurrence.terminalStatus !== "fail" ||
      (next.terminalStatus !== "pass" && nextEffective) ||
      (next.terminalStatus === "pass" && currentEffective)
    ) {
      throw new Error("retry selection contradicts the recorded terminal outcomes");
    }
  }
  resolveQaEvidenceContainment(summary.occurrences, summary.entries);
}

const qaEvidenceSummaryV3Schema = qaEvidenceSummaryV3Shape.superRefine((summary, context) => {
  try {
    validateOccurrenceBindings(summary);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
const qaVersionedEvidenceSummarySchema = z.discriminatedUnion("schemaVersion", [
  qaEvidenceSummarySchema,
  qaEvidenceSummaryV3Schema,
]);

type QaEvidenceProfile = z.infer<typeof qaEvidenceProfileIdSchema>;
export type QaEvidenceStatus = z.infer<typeof qaEvidenceStatusSchema>;
export type QaEvidenceTiming = z.infer<typeof qaEvidenceTimingSchema>;
export type QaEvidenceRttMeasurement = z.infer<typeof qaEvidenceRttMeasurementSchema>;
export type QaEvidencePackageSource = z.infer<typeof qaEvidencePackageSourceSchema>;
export type QaEvidenceScorecardJson = z.infer<typeof qaEvidenceScorecardSchema>;
type QaEvidenceSummaryV2Entry = z.infer<typeof qaEvidenceSummaryEntrySchema>;
export type QaEvidenceSummaryV3Entry = z.infer<typeof qaEvidenceSummaryV3EntrySchema>;
export type QaEvidenceSummaryEntry = QaEvidenceSummaryV2Entry | QaEvidenceSummaryV3Entry;
export type QaEvidenceSummaryV2Json = z.infer<typeof qaEvidenceSummarySchema>;
export type QaEvidenceSummaryV3Json = z.infer<typeof qaEvidenceSummaryV3Schema>;
export type QaEvidenceSummaryJson = QaEvidenceSummaryV2Json | QaEvidenceSummaryV3Json;
export type QaEvidenceOccurrence = z.infer<typeof qaEvidenceOccurrenceSchema>;
export type QaEvidenceAssertion = z.infer<typeof qaEvidenceAssertionSchema>;
export type QaEvidenceIdentity = z.infer<typeof qaEvidenceIdentitySchema>;
export {
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  qaEvidenceRttMeasurementSchema,
  qaEvidenceSummarySchema,
  qaEvidenceSummaryV3Schema,
  qaVersionedEvidenceSummarySchema,
};
export type { QaEvidenceProfile, QaEvidenceSummaryV2Entry };
