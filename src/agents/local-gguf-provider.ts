import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";

const GGUF_DEFAULT_CONTEXT_WINDOW = 8192;
const GGUF_DEFAULT_MAX_TOKENS = 4096;
const GGUF_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Recursively find all .gguf files in a directory
async function findGgufFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await findGgufFiles(fullPath)));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
        results.push(fullPath);
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      console.warn(`Failed to scan directory ${dir}:`, error);
    }
  }
  return results;
}

export async function discoverLocalGgufModels(
  folderPath: string,
): Promise<ModelDefinitionConfig[]> {
  const files = await findGgufFiles(folderPath);
  const models: ModelDefinitionConfig[] = [];

  for (const file of files) {
    const name = path.basename(file, ".gguf");
    const relativePath = path.relative(folderPath, file);

    models.push({
      id: relativePath,
      name: name,
      reasoning: name.toLowerCase().includes("r1") || name.toLowerCase().includes("reasoning"),
      input: ["text"],
      cost: GGUF_COST,
      contextWindow: GGUF_DEFAULT_CONTEXT_WINDOW,
      maxTokens: GGUF_DEFAULT_MAX_TOKENS,
    });
  }

  return models;
}

export async function resolveImplicitLocalGgufProvider(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelProviderConfig | null> {
  const providerConfig = params.config.models?.providers?.["local-gguf"];

  let folderPath: string | undefined;

  if (providerConfig?.baseUrl?.startsWith("file://")) {
    folderPath = providerConfig.baseUrl.slice(7);
  } else if (params.env?.MODEL_PATH) {
    folderPath = params.env.MODEL_PATH;
  }

  if (!folderPath) {
    return null;
  }

  const models = await discoverLocalGgufModels(folderPath);

  if (models.length === 0) {
    return null;
  }

  return {
    baseUrl: `file://${folderPath}`,
    api: "openai-completions",
    models,
  };
}
