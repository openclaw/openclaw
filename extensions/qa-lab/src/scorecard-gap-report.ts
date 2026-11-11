import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceOccurrence,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  activeQaMaturityTaxonomySurfaces,
  qaMaturityTaxonomyIdentity,
  type QaMaturityTaxonomy,
} from "./scorecard-taxonomy.js";

type Qualification = "qualified" | "gap" | "unknown";
type DeclarationStatus = "current" | "stale" | "unknown";

function assertionDeclarations(assertions: NonNullable<QaEvidenceOccurrence["assertions"]>) {
  return assertions
    .map(({ id, meaning, coverage }) => ({
      id,
      meaning,
      coverage: coverage
        .map(({ id: coverageId, role }) => ({ id: coverageId, role }))
        .toSorted(
          (left, right) => left.id.localeCompare(right.id) || left.role.localeCompare(right.role),
        ),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

/** A reporting projection only: it does not change scorecards or proof enforcement. */
export function buildQaScorecardGapReport(params: {
  taxonomy: QaMaturityTaxonomy;
  scenarios: readonly QaSeedScenarioWithSource[];
  evidence: QaEvidenceSummaryJson;
}) {
  const { taxonomy, scenarios, evidence } = params;
  const taxonomyIdentity = qaMaturityTaxonomyIdentity(taxonomy);
  const capturedIdentity = evidence.profilePlan?.taxonomyIdentity;
  const taxonomyStatus = !capturedIdentity
    ? "unknown"
    : capturedIdentity.version === taxonomyIdentity.version &&
        capturedIdentity.sha256 === taxonomyIdentity.sha256
      ? "current"
      : "stale";
  const profile = taxonomy.profiles.find((item) => item.id === evidence.profile);
  const requirements = profile?.proofRequirements ?? [];
  const occurrences = evidence.schemaVersion === 3 ? evidence.occurrences : [];
  const byId = new Map(occurrences.map((item) => [item.id, item]));
  const containment =
    evidence.schemaVersion === 3
      ? resolveQaEvidenceContainment(evidence.occurrences, evidence.entries)
      : undefined;
  const recordedEntries: readonly QaEvidenceSummaryEntry[] = evidence.entries;
  const effectiveEntries = new Set(getEffectiveQaEvidenceEntries(evidence));
  // Reporting owns these copies; captured evidence and declarations stay immutable.
  const entries = [...effectiveEntries].map((entry) =>
    Object.assign({}, entry, {
      coverage:
        containment && "binding" in entry
          ? containment.projectCoverage(entry.binding.occurrenceId, entry.coverage)
          : entry.coverage,
    }),
  );
  const outcomes = projectQaEvidenceScenarioOutcomes(evidence);

  function attemptFacts(occurrence: QaEvidenceOccurrence) {
    const scenario = scenarios.find((item) => item.id === occurrence.parentCell?.scenarioId);
    // Captured IDs alone do not establish that today's declaration means the
    // same thing. Keep this comparison local to reporting, not proof enforcement.
    const declarationStatus: DeclarationStatus =
      !scenario?.assertions?.length || !occurrence.assertions?.length
        ? "unknown"
        : scenario.execution.kind !== occurrence.parentCell?.executionKind ||
            JSON.stringify(assertionDeclarations(scenario.assertions)) !==
              JSON.stringify(assertionDeclarations(occurrence.assertions))
          ? "stale"
          : "current";
    const rows = recordedEntries.filter(
      (entry) => "binding" in entry && entry.binding.occurrenceId === occurrence.id,
    );
    const assertions = occurrence.assertions?.map((assertion) => {
      const bound = rows.filter(
        (entry) => "binding" in entry && entry.binding.assertionId === assertion.id,
      );
      return {
        id: assertion.id,
        complete:
          bound.length > 0 &&
          bound.every(
            (entry) =>
              entry.result.status === "pass" &&
              "binding" in entry &&
              occurrence.receipts.some((receipt) => receipt.id === entry.binding.receiptId),
          ),
      };
    });
    const enclosing: Array<{
      occurrenceId: string;
      terminalStatus: QaEvidenceOccurrence["terminalStatus"];
    }> = [];
    let parentId = containment?.parentById.get(occurrence.id);
    while (parentId) {
      const parent = byId.get(parentId)!;
      enclosing.push({ occurrenceId: parent.id, terminalStatus: parent.terminalStatus });
      parentId = containment?.parentById.get(parentId);
    }
    return {
      occurrenceId: occurrence.id,
      parentCell: occurrence.parentCell,
      retryOf: occurrence.retryOf,
      terminalStatus: occurrence.terminalStatus,
      effective:
        rows.some((entry) => "effective" in entry && entry.effective) &&
        (containment?.isActive(occurrence.id) ?? false),
      source: occurrence.launch.source,
      assertions: assertions ?? null,
      declarationStatus,
      enclosing,
      complete:
        declarationStatus === "current" &&
        occurrence.terminalStatus === "pass" &&
        assertions !== undefined &&
        assertions.length > 0 &&
        assertions.every((assertion) => assertion.complete) &&
        enclosing.every((parent) => parent.terminalStatus === "pass"),
    };
  }
  const attempts = occurrences
    .filter((item) => item.scenario?.kind !== "instance")
    .map(attemptFacts);
  const attemptsById = new Map(attempts.map((item) => [item.occurrenceId, item]));
  // The evaluator owns retry selection, dimensions and receipt phases. Apply
  // completeness to those exact attempts; never assemble a pass across retries.
  const proof = evidence.profilePlan
    ? qaProfileEvidencePlan.evaluateProof(
        { ...evidence.profilePlan, taxonomyIdentity, proofRequirements: requirements },
        evidence,
      )
    : [];
  const declarations = requirements.map((requirement) => {
    const result = proof.find((item) => item.id === requirement.id);
    const checks = result?.checks ?? [];
    const complete =
      checks.length > 0 &&
      checks.every(
        (check) => check.occurrenceId !== null && attemptsById.get(check.occurrenceId)?.complete,
      );
    // Missing declarations produce no evaluator check. Inspect only primary
    // claims in this requirement's retry context, including retained history.
    const attributionEntries =
      requirement.retryAcceptance === "all-recorded-attempts"
        ? recordedEntries
        : [...effectiveEntries];
    const unattributedObservation = attributionEntries.some((entry) => {
      const coverage =
        containment && "binding" in entry
          ? containment.projectCoverage(entry.binding.occurrenceId, entry.coverage)
          : entry.coverage;
      return (
        coverage.some((claim) => claim.id === requirement.coverageId && claim.role === "primary") &&
        "binding" in entry &&
        attemptsById.get(entry.binding.occurrenceId)?.declarationStatus === "unknown"
      );
    });
    const qualification: Qualification =
      taxonomyStatus !== "current" ||
      evidence.schemaVersion !== 3 ||
      !result ||
      unattributedObservation ||
      checks.some(
        (check) =>
          check.occurrenceId !== null &&
          attemptsById.get(check.occurrenceId)?.declarationStatus === "unknown",
      )
        ? "unknown"
        : result.qualified && complete
          ? "qualified"
          : "gap";
    return Object.assign({}, requirement, {
      qualification,
      checks: checks.map((check) =>
        Object.assign({}, check, {
          declarationStatus:
            check.occurrenceId === null
              ? null
              : (attemptsById.get(check.occurrenceId)?.declarationStatus ?? "unknown"),
          completeAttempt:
            check.occurrenceId === null
              ? false
              : (attemptsById.get(check.occurrenceId)?.complete ?? false),
        }),
      ),
    });
  });
  const coverageIds = [
    ...new Set(
      activeQaMaturityTaxonomySurfaces(taxonomy).flatMap((surface) =>
        surface.categories.flatMap((category) =>
          category.features.flatMap((feature) => feature.coverageIds),
        ),
      ),
    ),
  ].toSorted();
  const coverage = coverageIds.map((coverageId) => {
    const catalog = scenarios
      .flatMap((scenario) => {
        const role = scenario.coverage?.primary.includes(coverageId)
          ? "primary"
          : scenario.coverage?.secondary?.includes(coverageId)
            ? "secondary"
            : undefined;
        if (!role) {
          return [];
        }
        const plan = evidence.profilePlan;
        return [
          {
            scenarioId: scenario.id,
            sourcePath: scenario.sourcePath,
            role,
            selected: plan ? plan.selected.includes(scenario.id) : null,
            excludedReasons:
              plan?.excluded.find((item) => item.scenarioId === scenario.id)?.reasons ?? [],
            expectedCells:
              plan?.expectedCells.filter((cell) => cell.scenarioId === scenario.id) ?? [],
            missingCells:
              plan?.missingCells.filter((cell) => cell.scenarioId === scenario.id) ?? [],
            outcomes: outcomes.filter((item) => item.scenarioId === scenario.id),
          },
        ];
      })
      .toSorted((left, right) => left.scenarioId.localeCompare(right.scenarioId));
    const observed = entries.filter((entry) =>
      entry.coverage.some((claim) => claim.id === coverageId),
    );
    const required = declarations.filter(
      (item) => item.coverageId === coverageId && item.obligation === "required",
    );
    const qualification: Qualification =
      required.length === 0 || required.some((item) => item.qualification === "unknown")
        ? "unknown"
        : required.every((item) => item.qualification === "qualified")
          ? "qualified"
          : "gap";
    return {
      coverageId,
      catalogStatus: catalog.some((item) => item.role === "primary")
        ? "primary"
        : catalog.length > 0
          ? "secondary-only"
          : "unmapped",
      catalog,
      observed: observed.map((entry) => ({
        testId: entry.test.id,
        role: entry.coverage.find((claim) => claim.id === coverageId)!.role,
        status: entry.result.status,
        occurrenceId: "binding" in entry ? entry.binding.occurrenceId : null,
      })),
      qualification,
      requirementIds: declarations
        .filter((item) => item.coverageId === coverageId)
        .map((item) => item.id),
    };
  });
  // Active coverage rows are only a projection. Retain unrepresented legacy
  // and historical observations without turning them into current proof claims.
  const unmatchedObservations = recordedEntries.flatMap((entry) => {
    const projectedCoverage =
      containment && "binding" in entry
        ? containment.projectCoverage(entry.binding.occurrenceId, entry.coverage)
        : entry.coverage;
    const effective = effectiveEntries.has(entry);
    if (
      effective &&
      projectedCoverage.length > 0 &&
      entry.coverage.every(
        (claim) =>
          coverageIds.includes(claim.id) &&
          projectedCoverage.some(
            (projected) => projected.id === claim.id && projected.role === claim.role,
          ),
      )
    ) {
      return [];
    }
    return [
      {
        test: entry.test,
        result: entry.result,
        coverage: entry.coverage,
        projectedCoverage,
        binding: "binding" in entry ? entry.binding : null,
        recordedEffective: "effective" in entry ? entry.effective : null,
        effective,
      },
    ];
  });
  return {
    taxonomyIdentity,
    taxonomyStatus,
    evidence: {
      generatedAt: evidence.generatedAt,
      schemaVersion: evidence.schemaVersion,
      profile: evidence.profile ?? null,
    },
    coverage,
    declarations,
    attempts,
    unmatchedObservations,
  };
}

export type QaScorecardGapReport = ReturnType<typeof buildQaScorecardGapReport>;

export function renderQaScorecardGapMarkdownReport(report: QaScorecardGapReport): string {
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "|": "&#124;",
    "\r": " ",
    "\n": " ",
    "{": "&#123;",
    "}": "&#125;",
  };
  const text = (value: string) => value.replace(/[&<>|\r\n{}]/g, (char) => escapes[char]!);
  return [
    "## QA scorecard gaps",
    "",
    `Profile: ${text(report.evidence.profile ?? "unknown")}. Taxonomy: ${report.taxonomyStatus}.`,
    "",
    "Report only. UNKNOWN means no required declaration or insufficient attribution; it is not a product failure. Qualification requires complete passing assertions in the same terminal passing attempt. Scores and gates are unchanged.",
    "",
    "| Coverage ID | Catalog | Effective observations | Required proof | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...report.coverage.map((row) => {
      const detail =
        report.declarations
          .filter((item) => row.requirementIds.includes(item.id))
          .map((item) => {
            const checks = item.checks.map(
              (check) =>
                `${check.status}${check.completeAttempt ? "" : "/incomplete-attempt"}${
                  check.declarationStatus && check.declarationStatus !== "current"
                    ? `/${check.declarationStatus}-declaration`
                    : ""
                }`,
            );
            return `${item.id} (${item.obligation}): ${item.qualification}; ${checks.join(", ")}`;
          })
          .join("; ") || "No explicit proof requirements";
      return `| ${text(row.coverageId)} | ${row.catalogStatus} | ${row.observed.length} | ${row.qualification.toUpperCase()} | ${text(detail)} |`;
    }),
    "",
    ...(report.unmatchedObservations.length === 0
      ? []
      : [
          "### Unmatched observations",
          "",
          "Retained diagnostics only; these rows do not qualify current coverage or change scores and gates.",
          "",
          "| Test | Status | Recorded coverage | Effective |",
          "| --- | --- | --- | --- |",
          ...report.unmatchedObservations.map(
            (row) =>
              `| ${text(row.test.id)} | ${row.result.status} | ${text(row.coverage.map((claim) => `${claim.id} (${claim.role})`).join(", ") || "none")} | ${row.effective} |`,
          ),
          "",
        ]),
  ].join("\n");
}
