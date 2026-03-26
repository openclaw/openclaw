import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { findGitRoot } from "../infra/git-root.js";
import { resolveUserPath } from "../utils.js";

export const BUILD_RUN_ARTIFACT_NAMES = [
  "acceptance",
  "verify-pack",
  "build-report",
  "eval-report",
] as const;

export type BuildRunArtifactName = (typeof BUILD_RUN_ARTIFACT_NAMES)[number];

export const BUILD_RUNS_STATE_DIRNAME = "build-runs";
export const BUILD_RUNS_WORKSPACE_DIRNAME = ".openclaw";

const BUILD_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const AcceptanceArtifactSchema = z
  .object({
    goal: z.string().min(1),
    in_scope: z.array(z.string()).default([]),
    out_of_scope: z.array(z.string()).default([]),
    blocking_checks: z
      .array(
        z.object({
          id: z.string().min(1),
          description: z.string().min(1),
          kind: z.enum(["functional", "quality", "design", "ops"]),
        }),
      )
      .default([]),
    quality_bars: z.record(z.string(), z.enum(["required", "important", "optional"])).default({}),
  })
  .strict();

const VerifyPackArtifactSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: z.string().min(1),
            blocking: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .strict();

const BuildReportArtifactSchema = z
  .object({
    round: z.number().int().nonnegative(),
    summary: z.string().min(1),
    commands_run: z.array(z.string()).default([]),
    files_changed: z.array(z.string()).default([]),
    known_gaps: z.array(z.string()).default([]),
  })
  .strict();

const EvalReportArtifactSchema = z
  .object({
    status: z.enum(["passed", "failed", "incomplete"]),
    summary: z.string().min(1),
    blocking_findings: z.array(z.string()).default([]),
    retry_advice: z.array(z.string()).default([]),
  })
  .strict();

const BUILD_RUN_ARTIFACT_SCHEMAS = {
  acceptance: AcceptanceArtifactSchema,
  "verify-pack": VerifyPackArtifactSchema,
  "build-report": BuildReportArtifactSchema,
  "eval-report": EvalReportArtifactSchema,
} as const;

export type AcceptanceArtifact = z.infer<typeof AcceptanceArtifactSchema>;
export type VerifyPackArtifact = z.infer<typeof VerifyPackArtifactSchema>;
export type BuildReportArtifact = z.infer<typeof BuildReportArtifactSchema>;
export type EvalReportArtifact = z.infer<typeof EvalReportArtifactSchema>;

export type BuildRunArtifactMap = {
  acceptance: AcceptanceArtifact;
  "verify-pack": VerifyPackArtifact;
  "build-report": BuildReportArtifact;
  "eval-report": EvalReportArtifact;
};

export type ResolvedBuildRunRoot = {
  workspaceDir: string;
  runId: string;
  storage: "repo-local" | "state-dir";
  repoRoot?: string;
  workspaceSlug?: string;
  buildRunsRoot: string;
  runDir: string;
};

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

export function normalizeBuildRunId(runId: string): string {
  const trimmed = runId.trim();
  if (!BUILD_RUN_ID_PATTERN.test(trimmed)) {
    throw new Error(`Invalid build-run id "${runId}". Use [A-Za-z0-9][A-Za-z0-9._-]{0,127}.`);
  }
  return trimmed;
}

export function buildRunArtifactFilename(name: BuildRunArtifactName): string {
  return `${name}.json`;
}

export function slugifyBuildRunWorkspace(workspaceDir: string): string {
  const resolved = path.resolve(resolveUserPath(workspaceDir));
  const base = path
    .basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = base || "workspace";
  const digest = crypto.createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${name}-${digest}`;
}

export function resolveBuildRunRoot(params: {
  workspaceDir: string;
  runId: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedBuildRunRoot {
  const workspaceDir = path.resolve(resolveUserPath(params.workspaceDir));
  const runId = normalizeBuildRunId(params.runId);
  const repoRoot = findGitRoot(workspaceDir);
  if (repoRoot) {
    const buildRunsRoot = path.join(
      repoRoot,
      BUILD_RUNS_WORKSPACE_DIRNAME,
      BUILD_RUNS_STATE_DIRNAME,
    );
    return {
      workspaceDir,
      runId,
      storage: "repo-local",
      repoRoot,
      buildRunsRoot,
      runDir: path.join(buildRunsRoot, runId),
    };
  }
  const workspaceSlug = slugifyBuildRunWorkspace(workspaceDir);
  const buildRunsRoot = path.join(
    resolveStateDir(params.env),
    BUILD_RUNS_STATE_DIRNAME,
    workspaceSlug,
  );
  return {
    workspaceDir,
    runId,
    storage: "state-dir",
    workspaceSlug,
    buildRunsRoot,
    runDir: path.join(buildRunsRoot, runId),
  };
}

export function resolveBuildRunArtifactPath(params: {
  workspaceDir: string;
  runId: string;
  artifactName: BuildRunArtifactName;
  env?: NodeJS.ProcessEnv;
}): string {
  const root = resolveBuildRunRoot(params);
  return path.join(root.runDir, buildRunArtifactFilename(params.artifactName));
}

export async function ensureBuildRunRoot(params: {
  workspaceDir: string;
  runId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedBuildRunRoot> {
  const root = resolveBuildRunRoot(params);
  await fs.mkdir(root.runDir, { recursive: true });
  return root;
}

export function validateBuildRunArtifact<TName extends BuildRunArtifactName>(
  artifactName: TName,
  value: unknown,
): BuildRunArtifactMap[TName] {
  const schema = BUILD_RUN_ARTIFACT_SCHEMAS[artifactName];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${buildRunArtifactFilename(artifactName)}: ${formatZodIssues(parsed.error)}`,
    );
  }
  return parsed.data as BuildRunArtifactMap[TName];
}

export async function writeBuildRunArtifact<TName extends BuildRunArtifactName>(params: {
  workspaceDir: string;
  runId: string;
  artifactName: TName;
  value: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<{ path: string; value: BuildRunArtifactMap[TName] }> {
  const root = await ensureBuildRunRoot(params);
  const value = validateBuildRunArtifact(params.artifactName, params.value);
  const artifactPath = path.join(root.runDir, buildRunArtifactFilename(params.artifactName));
  await fs.writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  return { path: artifactPath, value };
}

export async function readBuildRunArtifact<TName extends BuildRunArtifactName>(params: {
  workspaceDir: string;
  runId: string;
  artifactName: TName;
  env?: NodeJS.ProcessEnv;
}): Promise<BuildRunArtifactMap[TName]> {
  const artifactPath = resolveBuildRunArtifactPath(params);
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unable to read file";
    throw new Error(`Unable to read ${buildRunArtifactFilename(params.artifactName)}: ${message}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid json";
    throw new Error(`Invalid ${buildRunArtifactFilename(params.artifactName)} JSON: ${message}`, {
      cause: error,
    });
  }
  return validateBuildRunArtifact(params.artifactName, parsed);
}

export function isReservedBuildRunWorkspacePath(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const parts = relative.split(path.sep).filter(Boolean);
  return parts[0] === BUILD_RUNS_WORKSPACE_DIRNAME && parts[1] === BUILD_RUNS_STATE_DIRNAME;
}
