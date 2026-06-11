import fs from "node:fs/promises";
import path from "node:path";
import { slugify } from "./text.js";

export type RunPaths = {
  rootDir: string;
  runDir: string;
  runId: string;
};

export function createRunId(seed: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `${date}-${time}-${slugify(seed).slice(0, 48)}`;
}

export function resolveRunPaths(outputDir: string, runId: string): RunPaths {
  const rootDir = path.resolve(outputDir);
  const safeRunId = slugify(runId);
  const runDir = path.resolve(rootDir, safeRunId);
  const relative = path.relative(rootDir, runDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("run path escapes book-writer output directory");
  }
  return { rootDir, runDir, runId: safeRunId };
}

export async function ensureRunDir(paths: RunPaths): Promise<void> {
  await fs.mkdir(paths.runDir, { recursive: true });
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeTextFile(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

export async function writeBinaryFile(filePath: string, value: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
