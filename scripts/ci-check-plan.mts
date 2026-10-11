#!/usr/bin/env node
// Materialize compiler and lint selections only after the check-planning job installs dependencies.
import { appendFileSync, existsSync } from "node:fs";
import { detectChangedLanes } from "./changed-lanes.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { isRecord } from "./lib/record-shared.mjs";
import {
  resolveChangedCiTsgoInputs,
  selectTsgoCoreTestStripe,
} from "./lib/tsgo-core-test-shards.mts";

type CheckRow = {
  check_name: string;
  task: string;
  runner: string;
  type_graph_names_json?: string;
  core_type_graph_names_json?: string;
  core_type_concurrency?: number;
};
type StripeRow = {
  stripe: number;
  lint_selection_json?: string;
  type_graph_names_json?: string;
  root_type_stripe?: string;
};
type Matrix<Row> = { include: Row[] };

export type CiCheckPlanInput = {
  changedBaseRef?: string;
  extensionLintMode?: "affected" | "full";
  preserveFullChecks?: boolean;
  typeGraphBoundaryOwner: "" | "check-plan" | "additional-checks";
  changedPaths: string[];
  changedCoreTestPaths: string[] | null;
  runnerProfile: string;
  checkMatrix: Matrix<CheckRow>;
  coreTypeMatrix: Matrix<StripeRow>;
  lintCoreMatrix: Matrix<StripeRow>;
  lintExtensionMatrix: Matrix<StripeRow>;
};

/** Narrow checks and pack complete extension fallback within the existing runner budget. */
export async function createCiCheckPlan(input: CiCheckPlanInput) {
  const runs = (task: string) => input.checkMatrix.include.some((row) => row.task === task);
  const lintPlan =
    runs("lint") && !input.preserveFullChecks
      ? await (
          await import("./check-changed.mts")
        ).createChangedCiLintPlan(detectChangedLanes(input.changedPaths), {
          runnerProfile: input.runnerProfile,
        })
      : null;
  const started = performance.now();
  const typePlan =
    !input.preserveFullChecks && (runs("prod-types") || runs("test-types"))
      ? await (
          await import("./run-tsgo-core-test-shards.mts")
        ).createChangedCiTypeCheckPlan(input.changedPaths, {
          cwd: process.cwd(),
          coreBoundaryOwner:
            input.typeGraphBoundaryOwner === "additional-checks" ? "additional-checks" : undefined,
        })
      : null;
  // Full selection needs no discovery, but a boundary without another admitted owner stays here.
  if (
    typePlan?.mode === "full" &&
    input.typeGraphBoundaryOwner === "check-plan" &&
    !resolveChangedCiTsgoInputs(input.changedPaths, existsSync)
  ) {
    const { checkCoreTsgoGraphBoundary } = await import("./check-tsgo-core-boundary.mts");
    await checkCoreTsgoGraphBoundary();
  }
  const graphs = typePlan?.graphs ?? [];
  const production = graphs.filter(({ name }) => ["core", "ui", "extensions"].includes(name));
  const coreTests = graphs.filter(({ name }) => name.startsWith("core-test-"));
  const hosted = ["github", "hybrid"].includes(input.runnerProfile);
  const otherOrder =
    !hosted && !input.changedCoreTestPaths
      ? ["extensions-test", "test-root", "scripts"]
      : ["extensions-test", "scripts", "test-root"];
  let other = otherOrder.flatMap((name) => graphs.filter((graph) => graph.name === name));
  if (production.length + coreTests.length + other.length !== graphs.length) {
    throw new Error("Every selected compiler graph must have a CI execution owner");
  }
  const centralCore = hosted ? [] : coreTests;
  if (
    (production.length > 0 && !runs("prod-types")) ||
    ((centralCore.length > 0 || other.length > 0) && !runs("test-types"))
  ) {
    throw new Error("Selected compiler graphs have no preflight check template");
  }
  const assignedCore = new Set<string>();
  const coreRows: StripeRow[] =
    input.preserveFullChecks && hosted
      ? input.coreTypeMatrix.include.map((row) => ({ ...row }))
      : typePlan && hosted
        ? input.coreTypeMatrix.include.flatMap((row) => {
            const configs = new Set(
              selectTsgoCoreTestStripe(`${row.stripe}/5`)?.map(({ config }) => config),
            );
            const selected = coreTests.filter(({ config }) => configs.has(config));
            for (const graph of selected) {
              assignedCore.add(graph.name);
            }
            return selected.length
              ? [
                  {
                    ...row,
                    type_graph_names_json: JSON.stringify(selected.map(({ name }) => name)),
                  },
                ]
              : [];
          })
        : [];
  if (!input.preserveFullChecks && hosted && assignedCore.size !== coreTests.length) {
    throw new Error("Selected core compiler graphs have no preflight stripe template");
  }
  // Reuse admitted rows only; small selections keep their serial central owner.
  // Each root partition runs after its row's concurrent core compilers settle.
  if (
    !input.preserveFullChecks &&
    coreRows.length >= 4 &&
    other.some(({ name }) => name === "test-root")
  ) {
    for (const [index, row] of coreRows.slice(-4).entries()) {
      row.root_type_stripe = `${index + 1}/4`;
    }
    other = other.filter(({ name }) => name !== "test-root");
  }
  const checkRows = input.checkMatrix.include.flatMap((row) => {
    if (input.preserveFullChecks) {
      return [row];
    }
    if (row.task === "prod-types") {
      return production.length
        ? [{ ...row, type_graph_names_json: JSON.stringify(production.map(({ name }) => name)) }]
        : [];
    }
    if (row.task === "test-types") {
      return centralCore.length || other.length
        ? [
            {
              ...row,
              core_type_graph_names_json: JSON.stringify(centralCore.map(({ name }) => name)),
              core_type_concurrency: !hosted && input.changedCoreTestPaths ? 2 : 1,
              type_graph_names_json: JSON.stringify(other.map(({ name }) => name)),
            },
          ]
        : [];
    }
    return [row];
  });
  const retainLintTemplates = (templates: Matrix<StripeRow>, selected: readonly StripeRow[]) => {
    if (
      selected.some((row) => !templates.include.some((template) => template.stripe === row.stripe))
    ) {
      throw new Error("Selected lint stripe has no preflight execution owner");
    }
    return templates.include.flatMap((template) => {
      const row = selected.find((candidate) => candidate.stripe === template.stripe);
      return row ? [{ ...template, lint_selection_json: row.lint_selection_json }] : [];
    });
  };
  let coreLint = lintPlan
    ? retainLintTemplates(input.lintCoreMatrix, lintPlan.core)
    : input.lintCoreMatrix.include;
  const extensionTemplates = lintPlan
    ? retainLintTemplates(input.lintExtensionMatrix, lintPlan.extensions)
    : input.lintExtensionMatrix.include;
  // Complete hybrid fallback can share setup and SDK preparation without changing its chunks.
  const compactExtensions =
    input.runnerProfile === "hybrid" &&
    runs("lint") &&
    lintPlan === null &&
    extensionTemplates.length === 6 &&
    extensionTemplates.every((row, index) => row.stripe === index + 1 && !row.lint_selection_json);
  let extensionLint: (StripeRow & { stripe_count?: number })[] = [];
  for (const row of extensionTemplates) {
    if (!compactExtensions) {
      extensionLint.push(row);
    } else if (row.stripe <= 3) {
      extensionLint.push({ ...row, stripe_count: 3 });
    }
  }
  let centralLintSelection = lintPlan ? JSON.stringify(lintPlan.central) : "";
  // Older targets omit this capability and retain their original full fallback.
  const extensionSelection =
    runs("lint") && input.extensionLintMode !== undefined
      ? await (
          await import("./lib/ci-extension-lint-plan.mts")
        ).resolveCiExtensionLintSelection(input.changedPaths, process.cwd(), {
          forceFull: input.extensionLintMode === "full",
          ...(input.changedBaseRef ? { baseRef: input.changedBaseRef } : {}),
        })
      : null;
  if (extensionSelection) {
    const {
      createExtensionOxlintShards,
      createOxlintExtensionRootScope,
      selectExtensionOxlintStripe,
    } = await import("./run-oxlint-shards.mts");
    const canonical = createExtensionOxlintShards({ platform: "linux" });
    const stripeCount = input.runnerProfile === "hybrid" ? 3 : hosted ? 6 : 1;
    const rootScope =
      extensionSelection.mode === "selected" && extensionSelection.extensionRoots.length > 0
        ? createOxlintExtensionRootScope(extensionSelection.extensionRoots, process.cwd())
        : null;
    const selectedStripes = Array.from({ length: stripeCount }, (_, index) => index + 1).filter(
      (index) => {
        if (
          extensionSelection.mode === "selected" &&
          extensionSelection.extensionRoots.length === 0
        ) {
          return false;
        }
        const shards = selectExtensionOxlintStripe(canonical, { index, total: stripeCount });
        return (rootScope ? rootScope.selectShards(shards) : shards).length > 0;
      },
    );
    type LintSelection = NonNullable<
      Awaited<ReturnType<typeof import("./check-changed.mts").createChangedCiLintPlan>>
    >["central"];
    const payload = (encoded: string | undefined, central: boolean): LintSelection => {
      const selected: LintSelection = encoded
        ? JSON.parse(encoded)
        : { files: [], coreStripes: [], extensionStripes: [], groups: [], central };
      return {
        ...selected,
        files: selected.files.filter((file) => !file.startsWith("extensions/")),
        extensionStripes: [],
        groups: selected.groups.filter((group) => group !== "extensions"),
      };
    };
    const withExtensions = (selection: LintSelection, stripes: number[]): LintSelection =>
      stripes.length === 0
        ? selection
        : {
            ...selection,
            extensionStripeCount: stripeCount,
            ...(extensionSelection.mode === "selected"
              ? { extensionRoots: extensionSelection.extensionRoots, extensionStripes: stripes }
              : { fullExtensionStripes: stripes }),
          };
    const central = payload(lintPlan ? JSON.stringify(lintPlan.central) : undefined, true);
    if (!lintPlan) {
      central.fullGroups = hosted ? ["scripts"] : ["core", "scripts"];
    }
    if (input.runnerProfile === "hybrid") {
      extensionLint = selectedStripes.map((stripeIndex) => {
        const template = input.lintExtensionMatrix.include.find(
          (row) => row.stripe === stripeIndex,
        );
        if (!template) {
          throw new Error("Selected extension lint stripe has no preflight execution owner");
        }
        return {
          ...template,
          stripe_count: stripeCount,
          lint_selection_json: JSON.stringify(
            withExtensions(payload(undefined, false), [stripeIndex]),
          ),
        };
      });
      centralLintSelection = JSON.stringify(central);
    } else if (hosted) {
      coreLint = input.lintCoreMatrix.include.flatMap((template) => {
        const current = coreLint.find((row) => row.stripe === template.stripe);
        const extensionStripes = selectedStripes.includes(template.stripe) ? [template.stripe] : [];
        if (!current && extensionStripes.length === 0) {
          return [];
        }
        const selected = payload(current?.lint_selection_json, false);
        if (!lintPlan && current) {
          selected.fullCoreStripes = [template.stripe];
        }
        if (
          !selected.files.length &&
          !selected.fullCoreStripes?.length &&
          !extensionStripes.length
        ) {
          return [];
        }
        return [
          {
            ...template,
            lint_selection_json: JSON.stringify(withExtensions(selected, extensionStripes)),
          },
        ];
      });
      extensionLint = [];
      centralLintSelection = JSON.stringify(
        withExtensions(
          central,
          selectedStripes.filter((stripeIndex) => stripeIndex === 6),
        ),
      );
    } else {
      extensionLint = [];
      centralLintSelection = JSON.stringify(withExtensions(central, selectedStripes));
    }
  }
  const checkJobCount =
    checkRows.length +
    (hosted ? coreRows.length + coreLint.length : 0) +
    (input.runnerProfile === "hybrid" ? extensionLint.length : 0);
  if (checkJobCount > 400) {
    throw new Error("Check planning exceeds the observer's 400-job inventory bound");
  }
  if (typePlan) {
    console.log(
      `CI type plan ${typePlan.mode} in ${((performance.now() - started) / 1000).toFixed(1)}s: ${graphs.map(({ name }) => name).join(", ")}`,
    );
  }
  return {
    check_job_count: checkJobCount,
    check_matrix: { include: checkRows },
    core_type_matrix: { include: coreRows },
    lint_core_matrix: { include: coreLint },
    lint_extension_matrix: { include: extensionLint },
    central_lint_selection_json: centralLintSelection,
    extension_lint_selection_json: extensionSelection ? JSON.stringify(extensionSelection) : "",
    run_lint_core: coreLint.length > 0,
    run_lint_extensions: extensionLint.length > 0,
    run_changed_core_type_stripes: coreRows.length > 0,
  };
}

function paths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((file) => typeof file === "string")
  ) {
    throw new Error("Check planning requires a complete changed-path array");
  }
  return value;
}

function matrix<Row>(value: unknown, parse: (row: unknown) => Row): Matrix<Row> {
  if (!isRecord(value) || !Array.isArray(value.include)) {
    throw new Error("Check planning requires a preflight matrix");
  }
  return { include: value.include.map(parse) };
}

function stripe(value: unknown): StripeRow {
  if (
    !isRecord(value) ||
    typeof value.stripe !== "number" ||
    !Number.isInteger(value.stripe) ||
    value.stripe < 1 ||
    value.stripe > 6
  ) {
    throw new Error("Check planning requires canonical stripe templates");
  }
  return { stripe: value.stripe };
}

function parseInput(value: unknown): CiCheckPlanInput {
  if (!isRecord(value) || typeof value.runnerProfile !== "string") {
    throw new Error("Check planning requires its preflight input");
  }
  if (
    value.extensionLintMode !== undefined &&
    value.extensionLintMode !== "affected" &&
    value.extensionLintMode !== "full"
  ) {
    throw new Error("Check planning requires affected or full extension lint mode");
  }
  if (value.preserveFullChecks !== undefined && typeof value.preserveFullChecks !== "boolean") {
    throw new Error("Check planning requires a boolean full-check policy");
  }
  if (
    value.changedBaseRef !== undefined &&
    (typeof value.changedBaseRef !== "string" || !/^[0-9a-f]{40}$/u.test(value.changedBaseRef))
  ) {
    throw new Error("Check planning requires a 40-hex changed base commit");
  }
  const boundaryOwner = value.typeGraphBoundaryOwner;
  if (
    boundaryOwner !== "" &&
    boundaryOwner !== "check-plan" &&
    boundaryOwner !== "additional-checks"
  ) {
    throw new Error("Check planning requires its compiler boundary owner");
  }
  return {
    ...(typeof value.changedBaseRef === "string" ? { changedBaseRef: value.changedBaseRef } : {}),
    ...(value.extensionLintMode === "affected" || value.extensionLintMode === "full"
      ? { extensionLintMode: value.extensionLintMode }
      : {}),
    ...(typeof value.preserveFullChecks === "boolean"
      ? { preserveFullChecks: value.preserveFullChecks }
      : {}),
    typeGraphBoundaryOwner: boundaryOwner,
    changedPaths: paths(value.changedPaths),
    changedCoreTestPaths:
      value.changedCoreTestPaths === null ? null : paths(value.changedCoreTestPaths),
    runnerProfile: value.runnerProfile,
    checkMatrix: matrix(value.checkMatrix, (row): CheckRow => {
      if (
        !isRecord(row) ||
        typeof row.check_name !== "string" ||
        typeof row.task !== "string" ||
        typeof row.runner !== "string"
      ) {
        throw new Error("Check planning requires canonical check templates");
      }
      return { check_name: row.check_name, task: row.task, runner: row.runner };
    }),
    coreTypeMatrix: matrix(value.coreTypeMatrix, stripe),
    lintCoreMatrix: matrix(value.lintCoreMatrix, stripe),
    lintExtensionMatrix: matrix(value.lintExtensionMatrix, stripe),
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runWithFailedTrailer("ci-check-plan", async () => {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) {
      throw new Error("Check planning requires GITHUB_OUTPUT");
    }
    const plan = await createCiCheckPlan(
      parseInput(JSON.parse(process.env.OPENCLAW_CI_CHECK_PLAN_INPUT_JSON ?? "null")),
    );
    if (plan.extension_lint_selection_json) {
      console.log(
        `[ci-check-plan] extension lint selection: ${plan.extension_lint_selection_json}`,
      );
    }
    if (plan.extension_lint_selection_json && process.env.GITHUB_STEP_SUMMARY) {
      const selection: Awaited<
        ReturnType<
          typeof import("./lib/ci-extension-lint-plan.mts").resolveCiExtensionLintSelection
        >
      > = JSON.parse(plan.extension_lint_selection_json);
      const escape = (text: string) =>
        text
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replace(/[\\`*_{}[\]()#+.!|]/gu, "\\$&")
          .replace(/[\r\n]/gu, " ");
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Extension lint selection\n\nMode: ${selection.mode}. Selected extensions: ${selection.mode === "full" ? "all canonical extensions" : selection.extensionRoots.length}.\n\n` +
          (selection.fullReasons.length
            ? `Full coverage: ${selection.fullReasons.map(escape).join("; ")}.\n\n`
            : "") +
          (selection.mode === "full"
            ? "The native full extension inventory remains selected.\n"
            : selection.extensionRoots.length
              ? "| Extension | Reasons |\n| --- | --- |\n" +
                selection.extensionRoots
                  .map(
                    (root) =>
                      `| ${escape(root)} | ${(selection.reasons[root] ?? []).map(escape).join("; ")} |\n`,
                  )
                  .join("")
              : "No affected extensions; extension lint is omitted.\n") +
          "\n",
      );
    }
    for (const [name, value] of Object.entries(plan)) {
      appendFileSync(
        output,
        `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
      );
    }
  });
}
