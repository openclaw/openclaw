import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readBoundedRegularFile } from "./actions-artifact-archive.mjs";
import {
  collectTestObservations,
  isObservationPath,
  observationFileId,
} from "./ci-test-observations.mjs";

type Observations = ReturnType<typeof collectTestObservations>;
type FileIdentity = { file: string; project: string; pool: string };
type ModelInput = FileIdentity & {
  runtime: {
    runtime: string;
    runtimeVersion: string;
    platform: string;
    arch: string;
    dependencyRoot: string;
  };
  dependencies: string[] | null;
};
type Tree = { score: number } | { feature: number; threshold: number; left: Tree; right: Tree };
const featureNames = [
  "basenameMatch",
  "pathTokenOverlap",
  "sameDirectory",
  "observedDependency",
  "changedPathCountLog",
];
const schema = "native-graph-v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tokens = (file: string) =>
  new Set(
    (file.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter(
      (part) => !["src", "test", "tests", "ts", "js"].includes(part),
    ),
  );
const directory = (file: string) => file.slice(0, file.lastIndexOf("/") + 1);
const stem = (file: string) =>
  file
    .slice(file.lastIndexOf("/") + 1)
    .replace(/\.[^.]+$/u, "")
    .replace(/\.(?:test|spec)$/u, "");

// This model is data, never an imported module. Validate once before traversing it.
function modelTree(value: unknown): { tree: Tree; used: Set<number> } {
  assert(value && typeof value === "object", "Missing model");
  const model = value as Record<string, unknown>;
  assert(model.version === 1 && model.featureSchema === schema, "Unknown model schema");
  assert(JSON.stringify(model.featureNames) === JSON.stringify(featureNames), "Feature mismatch");
  let nodes = 0;
  const used = new Set<number>();
  const visit = (input: unknown, depth: number): Tree => {
    assert(++nodes <= 63 && depth <= 8, "Model exceeds tree budget");
    assert(input && typeof input === "object" && !Array.isArray(input), "Invalid tree node");
    const node = input as Record<string, unknown>;
    if (Object.hasOwn(node, "score")) {
      assert(
        Object.keys(node).length === 1 &&
          typeof node.score === "number" &&
          Number.isFinite(node.score) &&
          node.score >= 0 &&
          node.score <= 1,
        "Invalid leaf",
      );
      return { score: node.score };
    }
    assert(
      Object.keys(node).toSorted().join(",") === "feature,left,right,threshold",
      "Invalid split",
    );
    assert(
      typeof node.feature === "number" &&
        Number.isInteger(node.feature) &&
        node.feature >= 0 &&
        node.feature < featureNames.length,
      "Invalid feature",
    );
    assert(
      typeof node.threshold === "number" && Number.isFinite(node.threshold),
      "Invalid threshold",
    );
    used.add(node.feature);
    return {
      feature: node.feature,
      threshold: node.threshold,
      left: visit(node.left, depth + 1),
      right: visit(node.right, depth + 1),
    };
  };
  return { tree: visit(model.tree, 0), used };
}

/** Freeze raw experimental scores. This function never selects or reorders tests. */
export function captureAdaptiveModelRanking(options: {
  current: Observations;
  baseline: Observations;
  changedFiles: string[];
  prior: unknown;
  modelBytes?: Buffer;
}) {
  const started = performance.now();
  const { current, baseline, changedFiles, prior } = options;
  const history = new Map<string, (string[] | null)[]>();
  for (const invocation of baseline.invocations) {
    for (const file of invocation.files) {
      const id = observationFileId(file);
      const entries = history.get(id) ?? [];
      entries.push(
        invocation.complete === true &&
          file.complete === true &&
          Array.isArray(file.dependencies) &&
          file.dependencies.every(isObservationPath)
          ? file.dependencies
          : null,
      );
      history.set(id, entries);
    }
  }
  // Deliberately exclude both current and prior outcomes/durations. These five
  // features describe paths and observed membership, not direct-edge distance.
  const inputs: ModelInput[] = current.invocations.flatMap((invocation) =>
    invocation.files.map(({ file, project, pool }: FileIdentity) => {
      const entries = history.get(observationFileId({ file, project, pool }));
      return {
        file,
        project,
        pool,
        runtime: {
          runtime: invocation.runtime,
          runtimeVersion: invocation.runtimeVersion,
          platform: invocation.platform,
          arch: invocation.arch,
          dependencyRoot: invocation.dependencyRoot,
        },
        dependencies: entries?.length === 1 ? entries[0]! : null,
      };
    }),
  );
  const rows = inputs.map(({ file, project, pool }) => ({
    file,
    project,
    pool,
    score: null as number | null,
    unknownReasons: [] as string[],
  }));
  const result = {
    version: 1,
    featureSchema: schema,
    extractorSha256: null as string | null,
    modelSha256: null as string | null,
    inputSha256: hash({ context: current.context, prior, changedFiles, inputs }),
    rows,
    elapsedMs: 0,
  };
  try {
    assert(inputs.length * changedFiles.length <= 1_000_000, "Comparison exceeds model budget");
    result.extractorSha256 = createHash("sha256")
      .update(
        readBoundedRegularFile(new URL(import.meta.url), {
          label: "Adaptive CI extractor",
          maxBytes: 64 * 1024,
        }),
      )
      .digest("hex");
    const bytes =
      options.modelBytes ??
      readBoundedRegularFile(new URL("../ci-adaptive-model.json", import.meta.url), {
        label: "Adaptive CI model",
        maxBytes: 64 * 1024,
      });
    assert(bytes.length <= 64 * 1024, "Model exceeds byte budget");
    result.modelSha256 = createHash("sha256").update(bytes).digest("hex");
    const { tree, used } = modelTree(JSON.parse(bytes.toString("utf8")));
    const changedTokens = changedFiles.map(tokens);
    for (const [index, input] of inputs.entries()) {
      const row = rows[index]!;
      if (used.has(3) && input.dependencies == null) {
        row.unknownReasons.push("missing-prior-dependencies");
        continue;
      }
      const target = tokens(input.file);
      const overlap = changedTokens.map(
        (parts) =>
          [...target].filter((part) => parts.has(part)).length /
          Math.max(1, new Set([...target, ...parts]).size),
      );
      const features = [
        Number(changedFiles.some((file) => stem(file) === stem(input.file))),
        overlap.reduce((maximum, value) => Math.max(maximum, value), 0),
        Number(changedFiles.some((file) => directory(file) === directory(input.file))),
        Number(changedFiles.some((file) => input.dependencies?.includes(file))),
        Math.log1p(changedFiles.length),
      ];
      let node = tree;
      while (!("score" in node)) {
        node = features[node.feature]! <= node.threshold ? node.left : node.right;
      }
      row.score = node.score;
    }
  } catch {
    for (const row of rows) {
      row.score = null;
      row.unknownReasons = ["model-unavailable-or-invalid"];
    }
  }
  result.elapsedMs = performance.now() - started;
  return result;
}
