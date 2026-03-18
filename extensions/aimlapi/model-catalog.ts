import fs from "node:fs/promises";
import path from "node:path";
import type { ModelCatalogEntry, ModelInputType } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderAugmentModelCatalogContext } from "openclaw/plugin-sdk/core";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("aimlapi/catalog");

type AimlapiModelsJson = {
  providers?: {
    aimlapi?: {
      models?: unknown;
    };
  };
};

function normalizeConfiguredModelInput(input: unknown): ModelInputType[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is ModelInputType => item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readAimlapiModelEntries(
  rawModels: unknown,
  seen: Set<string>,
): ProviderAugmentModelCatalogContext["entries"] {
  if (!Array.isArray(rawModels)) {
    return [];
  }

  const entries: ModelCatalogEntry[] = [];
  for (const model of rawModels) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const idRaw = (model as { id?: unknown }).id;
    if (typeof idRaw !== "string") {
      continue;
    }
    const id = idRaw.trim();
    if (!id) {
      continue;
    }

    const key = `aimlapi::${id.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const rawName = (model as { name?: unknown }).name;
    const name = (typeof rawName === "string" ? rawName : id).trim() || id;
    const contextWindowRaw = (model as { contextWindow?: unknown }).contextWindow;
    const contextWindow =
      typeof contextWindowRaw === "number" && contextWindowRaw > 0 ? contextWindowRaw : undefined;
    const reasoningRaw = (model as { reasoning?: unknown }).reasoning;
    const reasoning = typeof reasoningRaw === "boolean" ? reasoningRaw : undefined;
    const input = normalizeConfiguredModelInput((model as { input?: unknown }).input);
    entries.push({ id, name, provider: "aimlapi", contextWindow, reasoning, input });
  }

  return entries;
}

export async function augmentAimlapiModelCatalog(
  ctx: ProviderAugmentModelCatalogContext,
): Promise<ProviderAugmentModelCatalogContext["entries"]> {
  if (!ctx.agentDir) {
    return [];
  }

  const seen = new Set(
    ctx.entries.map(
      (entry) => `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`,
    ),
  );

  try {
    const modelsJsonPath = path.join(ctx.agentDir, "models.json");
    const modelsJsonRaw = await fs.readFile(modelsJsonPath, "utf8");
    const modelsJson = JSON.parse(modelsJsonRaw) as AimlapiModelsJson;
    return readAimlapiModelEntries(modelsJson.providers?.aimlapi?.models, seen);
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    log.warn(`Failed to read AIMLAPI model catalog supplement: ${String(error)}`);
    return [];
  }
}
