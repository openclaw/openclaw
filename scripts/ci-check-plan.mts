#!/usr/bin/env node
// Materialize compiler and lint selections only after the check-planning job installs dependencies.
import { appendFileSync } from "node:fs";
import { detectChangedLanes } from "./changed-lanes.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { isRecord } from "./lib/record-shared.mjs";
import { selectTsgoCoreTestStripe } from "./lib/tsgo-core-test-shards.mts";

type CheckRow = {
  check_name: string;
  task: string;
  runner: string;
  type_graph_names_json?: string;
  core_type_graph_names_json?: string;
  core_type_concurrency?: number;
};
type StripeRow = { stripe: number; lint_selection_json?: string; type_graph_names_json?: string };
type Matrix<Row> = { include: Row[] };

export type CiCheckPlanInput = {
  changedPaths: string[];
  changedCoreTestPaths: string[] | null;
  runnerProfile: string;
  checkMatrix: Matrix<CheckRow>;
  coreTypeMatrix: Matrix<StripeRow>;
  lintCoreMatrix: Matrix<StripeRow>;
  lintExtensionMatrix: Matrix<StripeRow>;
};

/** Narrow the preflight's row templates without changing their resource or execution owners. */
export async function createCiCheckPlan(input: CiCheckPlanInput) {
  const runs = (task: string) => input.checkMatrix.include.some((row) => row.task === task);
  const lintPlan = runs("lint")
    ? await (
        await import("./check-changed.mts")
      ).createChangedCiLintPlan(detectChangedLanes(input.changedPaths), {
        runnerProfile: input.runnerProfile,
      })
    : null;
  const started = performance.now();
  const typePlan =
    runs("prod-types") || runs("test-types")
      ? await (
          await import("./run-tsgo-core-test-shards.mts")
        ).createChangedCiTypeCheckPlan(input.changedPaths, { cwd: process.cwd() })
      : null;
  const graphs = typePlan?.graphs ?? [];
  const production = graphs.filter(({ name }) => ["core", "ui", "extensions"].includes(name));
  const coreTests = graphs.filter(({ name }) => name.startsWith("core-test-"));
  const hosted = ["github", "hybrid"].includes(input.runnerProfile);
  const otherOrder =
    !hosted && !input.changedCoreTestPaths
      ? ["extensions-test", "test-root", "scripts"]
      : ["extensions-test", "scripts", "test-root"];
  const other = otherOrder.flatMap((name) => graphs.filter((graph) => graph.name === name));
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
  const coreRows =
    typePlan && hosted
      ? input.coreTypeMatrix.include.flatMap((row) => {
          const configs = new Set(
            selectTsgoCoreTestStripe(`${row.stripe}/5`)?.map(({ config }) => config),
          );
          const selected = coreTests.filter(({ config }) => configs.has(config));
          for (const graph of selected) {
            assignedCore.add(graph.name);
          }
          return selected.length
            ? [{ ...row, type_graph_names_json: JSON.stringify(selected.map(({ name }) => name)) }]
            : [];
        })
      : [];
  if (hosted && assignedCore.size !== coreTests.length) {
    throw new Error("Selected core compiler graphs have no preflight stripe template");
  }
  const checkRows = input.checkMatrix.include.flatMap((row) => {
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
  const coreLint = lintPlan
    ? retainLintTemplates(input.lintCoreMatrix, lintPlan.core)
    : input.lintCoreMatrix.include;
  const extensionLint = lintPlan
    ? retainLintTemplates(input.lintExtensionMatrix, lintPlan.extensions)
    : input.lintExtensionMatrix.include;
  if (typePlan) {
    console.log(
      `CI type plan ${typePlan.mode} in ${((performance.now() - started) / 1000).toFixed(1)}s: ${graphs.map(({ name }) => name).join(", ")}`,
    );
  }
  return {
    check_matrix: { include: checkRows },
    core_type_matrix: { include: coreRows },
    lint_core_matrix: { include: coreLint },
    lint_extension_matrix: { include: extensionLint },
    central_lint_selection_json: lintPlan ? JSON.stringify(lintPlan.central) : "",
    run_lint_core: coreLint.length > 0,
    run_lint_extensions: extensionLint.length > 0,
    run_changed_core_type_stripes: coreRows.length > 0,
    type_graph_boundary_checked: typePlan !== null,
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
  return {
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
    for (const [name, value] of Object.entries(plan)) {
      appendFileSync(
        output,
        `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
      );
    }
  });
}
