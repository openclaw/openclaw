import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCAL_MODEL_FILE_EXTENSIONS = new Set([
  ".gguf",
  ".bin",
  ".safetensors",
  ".onnx",
  ".pt",
  ".pth",
  ".ckpt",
]);

export function resolveLocalModelsDir(): string {
  const configured = process.env.OPENCLAW_LOCAL_MODELS_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), "local_models");
}

function normalizeLocalModelId(rawName: string): string {
  const parsed = path.parse(rawName);
  const base = parsed.ext ? parsed.name : rawName;
  return base.trim();
}

export async function listLocalModelIds(params?: { dir?: string }): Promise<string[]> {
  const dir = path.resolve(params?.dir?.trim() || resolveLocalModelsDir());
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isDirectory()) {
      const id = normalizeLocalModelId(entry.name);
      if (id) {
        ids.push(id);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!LOCAL_MODEL_FILE_EXTENSIONS.has(ext)) {
      continue;
    }
    const id = normalizeLocalModelId(entry.name);
    if (id) {
      ids.push(id);
    }
  }

  return [...new Set(ids)].toSorted((a, b) => a.localeCompare(b));
}

export async function hasLocalModels(params?: { dir?: string }): Promise<boolean> {
  const ids = await listLocalModelIds(params);
  return ids.length > 0;
}
