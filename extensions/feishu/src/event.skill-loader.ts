import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeEnv } from "../runtime-api.js";
import {
  FEISHU_SKILL_SUBSCRIBERS_FILENAME,
  parseFeishuSkillSubscriberSpecJson,
  type FeishuSkillSubscriberDefinition,
  type FeishuSkillSubscriberFileSpec,
} from "./event.skill-spec.js";

const FEISHU_SKILL_LOADER_TAG = "[managed-by=feishu.event-skill-loader]";
const DEFAULT_SKILL_DISCOVERY_MAX_DEPTH = 3;

type LoaderRuntime = Pick<RuntimeEnv, "log" | "error">;

export type FeishuSkillSubscriberSkillSource = {
  skillName: string;
  skillFilePath: string;
  skillBaseDir: string;
};

export type FeishuLoadedSkillSubscriberManifest = {
  source: FeishuSkillSubscriberSkillSource;
  filePath: string;
  spec: FeishuSkillSubscriberFileSpec;
};

export type FeishuLoadedSkillSubscriber = {
  source: FeishuSkillSubscriberSkillSource;
  filePath: string;
  definition: FeishuSkillSubscriberDefinition;
};

export type FeishuSkillSubscriberLoadDiagnostic = {
  severity: "warn" | "error";
  filePath: string;
  skillName?: string;
  message: string;
};

export type FeishuSkillSubscriberLoadResult = {
  skillSources: readonly FeishuSkillSubscriberSkillSource[];
  manifests: readonly FeishuLoadedSkillSubscriberManifest[];
  subscribers: readonly FeishuLoadedSkillSubscriber[];
  diagnostics: readonly FeishuSkillSubscriberLoadDiagnostic[];
};

function isNotFoundError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
      )
      .map((entry) => path.join(dir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function resolveSkillLocalPath(params: {
  skillBaseDir: string;
  relativePath: string;
}): string | null {
  const resolved = path.resolve(params.skillBaseDir, params.relativePath);
  const relative = path.relative(params.skillBaseDir, resolved);
  if (
    relative === "" ||
    relative === "." ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  return null;
}

async function discoverSkillSourcesUnderRoot(params: {
  skillRoot: string;
  maxDepth: number;
}): Promise<FeishuSkillSubscriberSkillSource[]> {
  const discovered: FeishuSkillSubscriberSkillSource[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: path.resolve(params.skillRoot), depth: 0 },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const dir = current.dir;
    if (visited.has(dir)) {
      continue;
    }
    visited.add(dir);

    const skillFilePath = path.join(dir, "SKILL.md");
    if (await pathExists(skillFilePath)) {
      discovered.push({
        skillName: path.basename(dir),
        skillFilePath,
        skillBaseDir: dir,
      });
      continue;
    }

    if (current.depth >= params.maxDepth) {
      continue;
    }
    const children = await listDirectories(dir);
    for (const child of children) {
      queue.push({ dir: child, depth: current.depth + 1 });
    }
  }

  return discovered;
}

export async function discoverFeishuSkillSubscriberSources(params: {
  skillRoots: readonly string[];
  maxDepth?: number;
}): Promise<readonly FeishuSkillSubscriberSkillSource[]> {
  const maxDepth = Math.max(0, params.maxDepth ?? DEFAULT_SKILL_DISCOVERY_MAX_DEPTH);
  const discovered = await Promise.all(
    params.skillRoots.map((skillRoot) => discoverSkillSourcesUnderRoot({ skillRoot, maxDepth })),
  );
  return discovered
    .flat()
    .sort((left, right) => left.skillBaseDir.localeCompare(right.skillBaseDir));
}

export async function loadFeishuSkillSubscriberSpecs(params: {
  skillSources?: readonly FeishuSkillSubscriberSkillSource[];
  skillRoots?: readonly string[];
  maxDepth?: number;
  runtime?: LoaderRuntime;
}): Promise<FeishuSkillSubscriberLoadResult> {
  const log = params.runtime?.log ?? console.log;
  const error = params.runtime?.error ?? console.error;
  const diagnostics: FeishuSkillSubscriberLoadDiagnostic[] = [];
  const manifests: FeishuLoadedSkillSubscriberManifest[] = [];
  const subscribers: FeishuLoadedSkillSubscriber[] = [];
  const seenSubscriberIds = new Map<string, string>();

  const skillSources =
    params.skillSources ??
    (params.skillRoots
      ? await discoverFeishuSkillSubscriberSources({
          skillRoots: params.skillRoots,
          maxDepth: params.maxDepth,
        })
      : []);

  for (const source of skillSources) {
    const filePath = path.join(source.skillBaseDir, FEISHU_SKILL_SUBSCRIBERS_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (readError) {
      if (!isNotFoundError(readError)) {
        const message = `failed to read subscriber spec: ${String(readError)}`;
        diagnostics.push({
          severity: "error",
          filePath,
          skillName: source.skillName,
          message,
        });
        error(`${FEISHU_SKILL_LOADER_TAG} skill=${source.skillName} ${message}`);
      }
      continue;
    }

    const parsed = parseFeishuSkillSubscriberSpecJson(raw);
    if (!parsed.ok) {
      for (const issue of parsed.errors) {
        diagnostics.push({
          severity: "error",
          filePath,
          skillName: source.skillName,
          message: `${issue.path}: ${issue.message}`,
        });
      }
      error(
        `${FEISHU_SKILL_LOADER_TAG} skill=${source.skillName} invalid subscriber spec at ${filePath}`,
      );
      continue;
    }

    manifests.push({
      source,
      filePath,
      spec: parsed.value,
    });

    for (const definition of parsed.value.subscribers) {
      if (!definition.enabled) {
        continue;
      }
      if (definition.handler) {
        const handlerFilePath = resolveSkillLocalPath({
          skillBaseDir: source.skillBaseDir,
          relativePath: definition.handler.file,
        });
        if (!handlerFilePath) {
          diagnostics.push({
            severity: "error",
            filePath,
            skillName: source.skillName,
            message: `subscriber handler path "${definition.handler.file}" escapes skill directory`,
          });
          continue;
        }
        if (!(await pathExists(handlerFilePath))) {
          diagnostics.push({
            severity: "error",
            filePath,
            skillName: source.skillName,
            message: `subscriber handler file not found: ${definition.handler.file}`,
          });
          continue;
        }
      }
      const duplicateFilePath = seenSubscriberIds.get(definition.id);
      if (duplicateFilePath) {
        diagnostics.push({
          severity: "error",
          filePath,
          skillName: source.skillName,
          message: `duplicate subscriber id "${definition.id}" already declared in ${duplicateFilePath}`,
        });
        continue;
      }
      seenSubscriberIds.set(definition.id, filePath);
      subscribers.push({
        source,
        filePath,
        definition,
      });
      log(
        `${FEISHU_SKILL_LOADER_TAG} loaded subscriber id=${definition.id} skill=${source.skillName} hasHandler=${definition.handler ? "true" : "false"}`,
      );
    }
  }

  if (manifests.length > 0) {
    log(
      `${FEISHU_SKILL_LOADER_TAG} loaded ${manifests.length} subscriber spec file(s), ${subscribers.length} active subscriber(s)`,
    );
  }

  return {
    skillSources,
    manifests,
    subscribers,
    diagnostics,
  };
}
