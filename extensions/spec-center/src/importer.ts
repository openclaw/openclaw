import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseLegacyYamlSpec } from "./legacy-yaml.js";
import {
  extractMarkdownTitle,
  isSpecArtifactName,
  parseTasksMarkdown,
  summarizeMarkdown,
} from "./markdown.js";
import { buildRunPreview, checkSpec } from "./preview.js";
import {
  SPEC_ARTIFACT_NAMES,
  type ImportSpecInput,
  type SpecArtifact,
  type SpecImportResult,
  type SpecRecord,
  type SpecSource,
  type SpecStep,
} from "./types.js";

const execFileAsync = promisify(execFile);

export async function importSpecFromSource(input: ImportSpecInput): Promise<SpecImportResult> {
  const artifactDir = resolveArtifactDir(input);
  const now = new Date().toISOString();
  const legacy = await readLegacySpec(artifactDir);
  const markdownFiles = await readMarkdownArtifacts(artifactDir, legacy?.artifacts);
  const tasksMarkdown = markdownFiles.get("tasks.md")?.content ?? "";
  const steps = normalizeSteps(
    legacy?.steps.length ? legacy.steps : parseTasksMarkdown(tasksMarkdown),
  );
  const id = normalizeSpecId(input.id ?? legacy?.id ?? path.basename(artifactDir));
  const source = await buildSource({ input, artifactDir });
  const artifacts: SpecArtifact[] = SPEC_ARTIFACT_NAMES.flatMap((name) => {
    const artifact = markdownFiles.get(name);
    if (!artifact) {
      return [];
    }
    return [
      {
        name,
        path: path.join(artifactDir, name),
        ...(artifact.title ? { title: artifact.title } : {}),
        ...(artifact.summary ? { summary: artifact.summary } : {}),
        generated: artifact.generated,
      },
    ];
  });
  const targetRepo = input.targetRepo ?? legacy?.targetRepo;

  const spec: SpecRecord = {
    id,
    title:
      legacy?.title ??
      markdownFiles.get("overview.md")?.title ??
      markdownFiles.get("requirements.md")?.title ??
      id,
    type: legacy?.type ?? inferSpecType(id),
    status: normalizeStatus(legacy?.status),
    version: legacy?.version ?? 1,
    ...(legacy?.owner ? { owner: legacy.owner } : {}),
    ...(targetRepo ? { targetRepo } : {}),
    source,
    artifacts,
    artifactDir,
    steps,
    warnings: collectWarnings({ artifacts, steps, legacyLoaded: Boolean(legacy) }),
    importedAt: now,
    updatedAt: now,
  };
  const check = checkSpec(spec);
  const preview = buildRunPreview(spec);
  return { spec, check, preview };
}

function resolveArtifactDir(input: ImportSpecInput): string {
  const repo = input.repo?.trim();
  const specPath = input.path?.trim() || ".";
  if (repo && isLocalPath(repo)) {
    return path.resolve(expandHome(repo), specPath);
  }
  if (!repo && input.path) {
    return path.resolve(expandHome(specPath));
  }
  throw new Error("P0 import requires repo=<local path> or path=<local spec directory>.");
}

async function readMarkdownArtifacts(
  artifactDir: string,
  generated: Record<string, string> | undefined,
): Promise<Map<string, { content: string; title?: string; summary?: string; generated: boolean }>> {
  const result = new Map<
    string,
    { content: string; title?: string; summary?: string; generated: boolean }
  >();
  for (const name of SPEC_ARTIFACT_NAMES) {
    const filePath = path.join(artifactDir, name);
    const content = await readOptionalFile(filePath);
    const fallback = generated?.[name];
    const selected = content ?? fallback;
    if (!selected) {
      continue;
    }
    result.set(name, {
      content: selected,
      ...(extractMarkdownTitle(selected) ? { title: extractMarkdownTitle(selected) } : {}),
      ...(summarizeMarkdown(selected) ? { summary: summarizeMarkdown(selected) } : {}),
      generated: content === undefined,
    });
  }

  const entries = await fs.readdir(artifactDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || !isSpecArtifactName(entry.name)) {
      continue;
    }
    if (result.has(entry.name)) {
      continue;
    }
    const content = await fs.readFile(path.join(artifactDir, entry.name), "utf8");
    result.set(entry.name, {
      content,
      ...(extractMarkdownTitle(content) ? { title: extractMarkdownTitle(content) } : {}),
      ...(summarizeMarkdown(content) ? { summary: summarizeMarkdown(content) } : {}),
      generated: false,
    });
  }
  return result;
}

async function readLegacySpec(artifactDir: string) {
  for (const name of ["daily.yaml", "daily.yml", "spec.yaml", "spec.yml"]) {
    const content = await readOptionalFile(path.join(artifactDir, name));
    if (content) {
      return parseLegacyYamlSpec(content);
    }
  }
  return undefined;
}

async function buildSource(params: {
  input: ImportSpecInput;
  artifactDir: string;
}): Promise<SpecSource> {
  const repo = params.input.repo?.trim();
  const commit = await resolveGitCommit(params.artifactDir);
  return {
    kind: repo && isLocalPath(repo) ? "local" : "git",
    repo: repo ?? params.artifactDir,
    ...(params.input.ref ? { ref: params.input.ref } : {}),
    path: params.input.path?.trim() || ".",
    ...(commit ? { commit } : {}),
  };
}

async function resolveGitCommit(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 2_000,
    });
    const commit = stdout.trim();
    return commit || undefined;
  } catch {
    return undefined;
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function normalizeSteps(steps: SpecStep[]): SpecStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    if (!step.id || seen.has(step.id)) {
      return false;
    }
    seen.add(step.id);
    return true;
  });
}

function collectWarnings(params: {
  artifacts: SpecArtifact[];
  steps: SpecStep[];
  legacyLoaded: boolean;
}) {
  const warnings = [];
  if (params.legacyLoaded) {
    warnings.push({
      code: "legacy_yaml_imported",
      message: "Imported legacy YAML and generated Markdown-first artifacts for review.",
    });
  }
  for (const artifact of params.artifacts) {
    if (artifact.generated) {
      warnings.push({
        code: "generated_artifact",
        message: `${artifact.name} was generated from legacy input and should be reviewed.`,
      });
    }
  }
  if (params.steps.length === 0) {
    warnings.push({
      code: "no_steps_detected",
      message: "No executable steps were detected.",
    });
  }
  return warnings;
}

function normalizeSpecId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeStatus(value: string | undefined): SpecRecord["status"] {
  switch (value) {
    case "approved":
    case "running":
    case "succeeded":
    case "failed":
    case "blocked":
    case "archived":
    case "review":
    case "draft":
      return value;
    default:
      return "draft";
  }
}

function inferSpecType(id: string): string {
  return id.includes("daily") ? "daily_run" : "workflow";
}

function isLocalPath(value: string): boolean {
  return value.startsWith(".") || value.startsWith("/") || value.startsWith("~");
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
