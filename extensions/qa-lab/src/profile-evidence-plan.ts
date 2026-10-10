// QA Lab plugin module owns canonical profile scheduling evidence.
import { createHash } from "node:crypto";
import {
  QA_PROFILE_EVIDENCE_PLAN_LIST_NAMES as listNames,
  qaProfileEvidencePlanCellKey as cellKey,
  qaProfileEvidencePlanSchema as schema,
  resolveQaEvidenceContainment,
  type QaEvidenceIdentity,
  type QaEvidenceSummaryJson,
  type QaProfileEvidencePlan,
} from "./evidence-summary-schema.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScenarioExecutionCell } from "./scenario-lane.js";
import {
  qaMaturityTaxonomyIdentitySchema,
  type QaMaturityTaxonomyIdentity,
  type QaProofRequirements,
} from "./scorecard-taxonomy.js";

export type { QaProfileEvidencePlan } from "./evidence-summary-schema.js";

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalCells(cells: readonly QaScenarioExecutionCell[]) {
  return cells
    .map((cell) => ({ ...cell, channel: cell.channel ?? null }))
    .toSorted((left, right) => compareStrings(cellKey(left), cellKey(right)));
}

function build(params: {
  profile: string;
  taxonomyIdentity: QaMaturityTaxonomyIdentity;
  proofRequirements?: QaProofRequirements;
  membershipScenarios: readonly QaSeedScenarioWithSource[];
  selectedScenarios: readonly QaSeedScenarioWithSource[];
  excludedScenarios: readonly {
    scenario: QaSeedScenarioWithSource;
    reasons: readonly string[];
  }[];
  expectedCells: readonly QaScenarioExecutionCell[];
  observedCells: readonly QaScenarioExecutionCell[];
}) {
  const membership = params.membershipScenarios.map((scenario) => scenario.id).toSorted();
  const selected = params.selectedScenarios.map((scenario) => scenario.id).toSorted();
  const excluded = params.excludedScenarios
    .map(({ scenario, reasons }) => ({
      scenarioId: scenario.id,
      reasons: [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))].toSorted(),
    }))
    .toSorted((left, right) => compareStrings(left.scenarioId, right.scenarioId));
  const expectedCells = canonicalCells(params.expectedCells);
  const observedCells = canonicalCells(params.observedCells);
  const observedKeys = new Set(observedCells.map(cellKey));
  const missingCells = expectedCells.filter((cell) => !observedKeys.has(cellKey(cell)));
  const lists = { membership, selected, excluded, expectedCells, observedCells, missingCells };
  return schema.parse({
    profile: params.profile,
    ...lists,
    counts: Object.fromEntries(listNames.map((name) => [name, lists[name].length])),
    taxonomyIdentity: qaMaturityTaxonomyIdentitySchema.parse(params.taxonomyIdentity),
    ...(params.proofRequirements ? { proofRequirements: params.proofRequirements } : {}),
  });
}

type QaProofCheckStatus =
  | "qualified"
  | "conflict"
  | "failed"
  | "partial"
  | "incomplete"
  | "prerequisite"
  | "stale"
  | "insufficient";

type QaProofRequirementResult = {
  id: string;
  coverageId: string;
  obligation: "required" | "advisory";
  qualified: boolean;
  checks: Array<{
    occurrenceId: string | null;
    assertionId: string | null;
    status: QaProofCheckStatus;
  }>;
};

function proofDimensions(identity: QaEvidenceIdentity) {
  return {
    sourceRef: identity.source.ref,
    sourceIntegrity: identity.source.integrity,
    runtime: identity.runtime.id,
    runtimeVersion: identity.runtime.version,
    packageKind: identity.package?.kind ?? null,
    packageVersion: identity.package?.version ?? null,
    packageIntegrity: identity.package?.integrity ?? null,
    protocol: identity.protocol,
    accountRef: identity.accountRef,
    proofClass: identity.proofClass,
  };
}

/** Evaluate explicit owner declarations without changing raw outcomes or plan bytes. */
function evaluateProof(
  plan: QaProfileEvidencePlan,
  evidence: QaEvidenceSummaryJson,
): QaProofRequirementResult[] {
  return (plan.proofRequirements ?? []).map((requirement) => {
    const checks: QaProofRequirementResult["checks"] = [];
    const historicalIdentity = evidence.profilePlan?.taxonomyIdentity;
    const taxonomyStatus: QaProofCheckStatus | undefined =
      evidence.profilePlan && plan.taxonomyIdentity
        ? !historicalIdentity
          ? "insufficient"
          : JSON.stringify(historicalIdentity) !== JSON.stringify(plan.taxonomyIdentity)
            ? "stale"
            : undefined
        : undefined;
    if (taxonomyStatus) {
      checks.push({ occurrenceId: null, assertionId: null, status: taxonomyStatus });
    } else if (evidence.schemaVersion === 3) {
      const containment = resolveQaEvidenceContainment(evidence.occurrences, evidence.entries);
      const byId = new Map(evidence.occurrences.map((occurrence) => [occurrence.id, occurrence]));
      const activeObservations = new Set(
        evidence.entries
          .filter((entry) => entry.effective)
          .map((entry) => entry.binding.occurrenceId),
      );
      for (const occurrence of evidence.occurrences) {
        if (
          occurrence.scenario?.kind === "instance" &&
          occurrence.scenario.resultOccurrenceId !== null
        ) {
          activeObservations.add(occurrence.scenario.resultOccurrenceId);
        }
      }
      const superseded = new Set<string>();
      for (const id of activeObservations) {
        let prior = byId.get(id)?.retryOf;
        while (prior) {
          superseded.add(prior);
          prior = byId.get(prior)?.retryOf;
        }
      }
      for (const occurrence of evidence.occurrences) {
        if (occurrence.scenario?.kind === "instance") {
          continue;
        }
        const rows = evidence.entries.filter(
          (entry) => entry.binding.occurrenceId === occurrence.id,
        );
        // A rejected retry may emit no rows. Preserve recorded selection even
        // when its rows are missing, and keep independent observations visible.
        let prior = occurrence.retryOf;
        while (prior !== null && !activeObservations.has(prior)) {
          prior = byId.get(prior)?.retryOf ?? null;
        }
        const rejectedRetry =
          prior !== null &&
          occurrence.terminalStatus !== "pass" &&
          !activeObservations.has(occurrence.id);
        if (
          requirement.retryAcceptance === "selected-attempt" &&
          (superseded.has(occurrence.id) ||
            rejectedRetry ||
            rows[0]?.effective === false ||
            !containment.isActive(occurrence.id))
        ) {
          continue;
        }
        const declarations = occurrence.assertions?.filter((assertion) =>
          containment
            .projectCoverage(occurrence.id, assertion.coverage)
            .some(
              (coverage) => coverage.id === requirement.coverageId && coverage.role === "primary",
            ),
        );
        for (const assertion of declarations ?? []) {
          const bound = rows.filter(
            (entry) =>
              entry.binding.assertionId === assertion.id &&
              containment
                .projectCoverage(occurrence.id, entry.coverage)
                .some(
                  (coverage) =>
                    coverage.id === requirement.coverageId && coverage.role === "primary",
                ),
          );
          let status: QaProofCheckStatus = "qualified";
          if (bound.length === 0 || occurrence.terminalStatus === null) {
            status =
              occurrence.parentCell &&
              plan.missingCells.some((cell) => cellKey(cell) === cellKey(occurrence.parentCell!))
                ? "prerequisite"
                : "incomplete";
          } else {
            for (const entry of bound) {
              const receipt = occurrence.receipts.find(
                (candidate) => candidate.id === entry.binding.receiptId,
              );
              if (!receipt) {
                status = "insufficient";
                break;
              }
              const actual = proofDimensions(receipt.identity);
              const launch = occurrence.launch.source;
              if (
                (launch.ref && actual.sourceRef && launch.ref !== actual.sourceRef) ||
                (launch.integrity &&
                  actual.sourceIntegrity &&
                  launch.integrity !== actual.sourceIntegrity)
              ) {
                status = "stale";
                break;
              }
              const alternatives = requirement.alternatives.map((alternative) => {
                // SAFETY: Strict-schema keys match proofDimensions; values are used only in equality comparisons.
                const dimensions = Object.entries(alternative) as Array<
                  [keyof typeof actual, string]
                >;
                const matches = dimensions.every(([key, value]) => actual[key] === value);
                const runtimeRequired =
                  alternative.runtime !== undefined ||
                  alternative.runtimeVersion !== undefined ||
                  alternative.protocol !== undefined ||
                  alternative.accountRef !== undefined ||
                  (alternative.proofClass !== undefined &&
                    alternative.proofClass !== "packaged-install/upgrade");
                const phaseMatches = runtimeRequired
                  ? receipt.phase === "runtime"
                  : alternative.proofClass === "packaged-install/upgrade"
                    ? receipt.phase !== "prepared"
                    : true;
                if (matches && phaseMatches) {
                  return "qualified";
                }
                return dimensions.some(
                  ([key, value]) =>
                    key !== "proofClass" && actual[key] !== null && actual[key] !== value,
                )
                  ? "stale"
                  : "insufficient";
              });
              if (!alternatives.includes("qualified")) {
                status = alternatives.every((result) => result === "stale")
                  ? "stale"
                  : "insufficient";
                break;
              }
            }
            if (status === "qualified") {
              const statuses = new Set(bound.map((entry) => entry.result.status));
              status = statuses.has("fail")
                ? statuses.has("pass")
                  ? "conflict"
                  : "failed"
                : statuses.has("blocked") || statuses.has("skipped")
                  ? "partial"
                  : "qualified";
            }
          }
          checks.push({ occurrenceId: occurrence.id, assertionId: assertion.id, status });
        }
      }
    }
    if (checks.length === 0) {
      checks.push({ occurrenceId: null, assertionId: null, status: "insufficient" });
    }
    return {
      id: requirement.id,
      coverageId: requirement.coverageId,
      obligation: requirement.obligation,
      qualified: checks.every((check) => check.status === "qualified"),
      checks,
    };
  });
}

function attest(value: unknown, successful = false, evidence?: QaEvidenceSummaryJson) {
  const plan = schema.parse(value);
  if (successful && plan.missingCells.length > 0) {
    throw new Error(
      `successful QA profile evidence is missing ${plan.missingCells.length} expected execution cell(s)`,
    );
  }
  // Plan-only callers retain the existing digest contract. Evidence owners may
  // additionally qualify explicit obligations; primary coverage creates none.
  const proof = evidence ? evaluateProof(plan, evidence) : undefined;
  const unqualified = proof?.filter(
    (requirement) => requirement.obligation === "required" && !requirement.qualified,
  );
  if (successful && unqualified?.length) {
    throw new Error(
      `successful QA profile evidence has unqualified declared proof: ${unqualified
        .map(
          (requirement) =>
            `${requirement.id} (${requirement.checks.map((check) => check.status).join(", ")})`,
        )
        .join("; ")}`,
    );
  }
  return {
    plan,
    sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    ...(proof?.length ? { proof } : {}),
  };
}

export const qaProfileEvidencePlan = {
  attest,
  build,
  evaluateProof,
  schema,
};
