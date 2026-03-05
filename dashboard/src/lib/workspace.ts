import fs from "fs/promises";
import path from "path";

export function getOpenClawPath(): string {
  return process.env.OPENCLAW_WORKSPACE_PATH || path.join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw");
}

export function getWorkspacePath(): string {
  return path.join(getOpenClawPath(), "workspace");
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(dirPath: string, ext?: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (ext) files = files.filter((f) => f.endsWith(ext));
    return files;
  } catch {
    return [];
  }
}

export async function listDirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export function apiResponse<T>(data: T) {
  return Response.json({ data, timestamp: new Date().toISOString() });
}

export function apiError(message: string, status = 500) {
  return Response.json({ error: message, timestamp: new Date().toISOString() }, { status });
}
