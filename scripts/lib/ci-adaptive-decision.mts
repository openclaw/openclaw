import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { readBoundedRegularFile } from "./actions-artifact-archive.mjs";
import { captureAdaptiveModelRanking } from "./ci-adaptive-model.mts";
import { planAdaptiveSelection } from "./ci-adaptive-selection.mjs";
import {
  collectTestObservations,
  decodeTestObservations,
  isObservationPath,
  observationContext,
} from "./ci-test-observations.mjs";

type Observations = ReturnType<typeof collectTestObservations>;
type Prior = {
  artifactId: number;
  runId: number;
  runAttempt: number;
  createdAt: string;
  archiveSha256: string;
  memberPath: string;
  memberSha256: string;
  observations: { observations: unknown };
  comparison: {
    baseRevision: string;
    baseTree: string;
    headRevision: string;
    headTree: string;
    changedFiles: string[];
  };
};
const sha = /^[a-f0-9]{64}$/;
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const sameRuntime = (
  a: Observations["invocations"][number],
  b: Observations["invocations"][number],
) =>
  (["runtime", "runtimeVersion", "platform", "arch", "dependencyRoot"] as const).every(
    (key) => a[key] === b[key],
  );

// This record is captured from the native inventory callback, before any tests run.
// It describes a graph proposal; the runner always keeps the original inventory.
export function captureAdaptiveGraphDecision(options: {
  repositoryRoot: string;
  observations: Observations;
  env: NodeJS.ProcessEnv;
  recordedAt: string;
}) {
  const { observations: current, env, repositoryRoot, recordedAt } = options;
  const files = current.invocations
    .flatMap((invocation) => invocation.files)
    .map(({ file, project, pool }) => ({ file, project, pool }));
  const fallbackReasons: string[] = [];
  const decision = {
    version: 1,
    mode: "shadow",
    recordedAt,
    selector: "dependency-graph-v1",
    bundleSha256: null as string | null,
    prior: null as Omit<Prior, "observations" | "comparison"> | null,
    comparison: null as { revision: string; tree: string; changedFiles: string[] } | null,
    graph: null as ReturnType<typeof planAdaptiveSelection> | null,
    ranking: null as ReturnType<typeof captureAdaptiveModelRanking> | null,
    scheduledFiles: files,
    fallbackReasons,
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    const bytes = readBoundedRegularFile(
      path.join(repositoryRoot, ".artifacts/ci-adaptive-priors.json"),
      {
        label: "Adaptive CI priors",
        maxBytes: 32 * 1024 * 1024,
      },
    );
    decision.bundleSha256 = createHash("sha256").update(bytes).digest("hex");
    const bundle = JSON.parse(bytes.toString("utf8"));
    if (
      bundle.version !== 1 ||
      bundle.repository !== current.context.repository ||
      bundle.consumer?.runId !== env.GITHUB_RUN_ID ||
      bundle.consumer?.runAttempt !== env.GITHUB_RUN_ATTEMPT ||
      bundle.consumer?.revision !== current.context.revision ||
      bundle.consumer?.tree !== current.context.tree ||
      !date(bundle.restoredAt) ||
      !date(bundle.cutoffAt) ||
      Date.parse(bundle.cutoffAt) > Date.parse(bundle.restoredAt) ||
      Date.parse(bundle.restoredAt) > Date.parse(recordedAt) ||
      !Array.isArray(bundle.candidates) ||
      bundle.candidates.length > 4
    ) {
      throw new Error("Invalid prior bundle");
    }
    if (git("status", "--porcelain=v1", "--untracked-files=normal", "-z") !== "") {
      fallbackReasons.push("dirty-checkout");
      return decision;
    }
    const candidates: Prior[] = bundle.candidates;
    for (const prior of candidates.toSorted(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.artifactId - a.artifactId ||
        a.memberPath.localeCompare(b.memberPath),
    )) {
      try {
        if (
          ![prior.artifactId, prior.runId, prior.runAttempt].every(
            (value) => Number.isSafeInteger(value) && value > 0,
          ) ||
          !date(prior.createdAt) ||
          Date.parse(prior.createdAt) >= Date.parse(bundle.cutoffAt) ||
          typeof prior.archiveSha256 !== "string" ||
          !sha.test(prior.archiveSha256) ||
          typeof prior.memberSha256 !== "string" ||
          !sha.test(prior.memberSha256) ||
          !isObservationPath(prior.memberPath)
        ) {
          throw new Error("Invalid prior identity");
        }
        const baseline = decodeTestObservations(prior.observations.observations);
        const context = observationContext(baseline.context);
        if (
          baseline.version !== 1 ||
          !Array.isArray(baseline.invocations) ||
          baseline.invocations.length !== current.invocations.length ||
          !(["repository", "configDigest", "lockDigest", "environmentDigest"] as const).every(
            (key) => context[key] === current.context[key],
          ) ||
          !baseline.invocations.every((invocation, index) =>
            sameRuntime(invocation, current.invocations[index]!),
          )
        ) {
          fallbackReasons.push("incompatible-prior");
          continue;
        }
        // Preflight binds the comparison to both exact trees. No history or
        // network access is needed in this shallow test checkout.
        const comparison = prior.comparison;
        if (
          comparison?.baseRevision !== context.revision ||
          comparison.baseTree !== context.tree ||
          comparison.headRevision !== current.context.revision ||
          comparison.headTree !== current.context.tree ||
          !Array.isArray(comparison.changedFiles) ||
          comparison.changedFiles.length >= 600 ||
          comparison.changedFiles.some((file) => !isObservationPath(file)) ||
          new Set(comparison.changedFiles).size !== comparison.changedFiles.length
        ) {
          throw new Error("Invalid prior comparison");
        }
        const changedFiles = comparison.changedFiles;
        const graph = planAdaptiveSelection(baseline, {
          version: 1,
          context: current.context,
          baselineRevision: context.revision,
          baselineTree: context.tree,
          files,
          changedFiles,
          audit: false,
        });
        decision.prior = {
          artifactId: prior.artifactId,
          runId: prior.runId,
          runAttempt: prior.runAttempt,
          createdAt: prior.createdAt,
          archiveSha256: prior.archiveSha256,
          memberPath: prior.memberPath,
          memberSha256: prior.memberSha256,
        };
        decision.comparison = { revision: context.revision, tree: context.tree, changedFiles };
        decision.graph = graph;
        decision.ranking = captureAdaptiveModelRanking({
          current,
          baseline,
          changedFiles,
          prior: decision.prior,
        });
        fallbackReasons.length = 0;
        fallbackReasons.push(...graph.fallbackReasons);
        return decision;
      } catch {
        fallbackReasons.push("prior-source-or-data-unavailable");
      }
    }
    fallbackReasons.push("no-compatible-prior");
  } catch {
    fallbackReasons.push("prior-bundle-unavailable");
  }
  decision.fallbackReasons = [...new Set(fallbackReasons)];
  return decision;
}
