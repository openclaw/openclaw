import fs from "node:fs/promises";
import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_REF,
  DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_URI,
  LLAMA_CPP_PROVIDER_ID,
  buildLlamaCppProviderConfig,
  resolveCachedLlamaCppModelPath,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import {
  formatLlamaCppSetupError,
  importNodeLlamaCpp,
  type NodeLlamaCppModule,
} from "./node-llama.runtime.js";

function readPrimaryModel(config: ProviderAppGuidedSetupContext["config"]): string | undefined {
  const model = config.agents?.defaults?.model;
  return typeof model === "string" ? model : model?.primary;
}

function configuredCandidates(
  config: ProviderAppGuidedSetupContext["config"],
): Array<{ model: ModelDefinitionConfig; provider: ModelProviderConfig }> {
  const existing = config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const provider = buildLlamaCppProviderConfig(existing);
  const primary = readPrimaryModel(config);
  const primaryId = primary?.startsWith(`${LLAMA_CPP_PROVIDER_ID}/`)
    ? primary.slice(LLAMA_CPP_PROVIDER_ID.length + 1)
    : undefined;
  return provider.models
    .map((model) => ({ model, provider }))
    .toSorted((a, b) => Number(b.model.id === primaryId) - Number(a.model.id === primaryId));
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function detectLlamaCppSetup(ctx: ProviderAppGuidedSetupContext) {
  let runtime: NodeLlamaCppModule;
  try {
    runtime = await importNodeLlamaCpp();
  } catch {
    return null;
  }
  for (const candidate of configuredCandidates(ctx.config)) {
    try {
      const cachedPath = await runtime.resolveModelFile(
        resolveLlamaCppModelSource(candidate.model),
        {
          directory: resolveLlamaCppModelCacheDir(candidate.provider),
          download: false,
          cli: false,
        },
      );
      if (!(await isFile(cachedPath))) {
        continue;
      }
      return {
        modelRef: `${LLAMA_CPP_PROVIDER_ID}/${candidate.model.id}`,
        detail: `${candidate.model.id} (downloaded)`,
      };
    } catch {
      // Discovery is read-only: a missing model or native module is not a setup error.
    }
  }
  return null;
}

function buildSetupResult(
  config: ProviderAppGuidedSetupContext["config"],
  defaultModel = DEFAULT_LLAMA_CPP_MODEL_REF,
): ProviderAuthResult {
  return {
    profiles: [],
    defaultModel,
    configPatch: {
      models: {
        mode: config.models?.mode ?? "merge",
        providers: {
          [LLAMA_CPP_PROVIDER_ID]: buildLlamaCppProviderConfig(
            config.models?.providers?.[LLAMA_CPP_PROVIDER_ID],
          ),
        },
      },
    },
  };
}

export async function prepareLlamaCppSetup(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const detected = await detectLlamaCppSetup(ctx);
  return detected?.modelRef === ctx.modelRef ? buildSetupResult(ctx.config, ctx.modelRef) : null;
}

export async function runLlamaCppSetup(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const cacheDir = resolveLlamaCppModelCacheDir(existing);
  const cachedPath = resolveCachedLlamaCppModelPath({
    model: {
      id: DEFAULT_LLAMA_CPP_MODEL_ID,
      params: { modelPath: DEFAULT_LLAMA_CPP_MODEL_URI },
    },
    provider: existing,
  });
  if (!cachedPath || !(await isFile(cachedPath))) {
    const consent = await ctx.prompter.confirm({
      message:
        "Download Qwen3 4B Instruct 2507 Q4_K_M (about 2.5 GB) for local llama.cpp inference?",
      initialValue: false,
    });
    if (!consent) {
      await ctx.prompter.note("Local model download skipped.", "Setup skipped");
      return { profiles: [] };
    }
    const progress = ctx.prompter.progress("Preparing Qwen3 4B model download…");
    try {
      const runtime = await importNodeLlamaCpp();
      const downloader = await runtime.createModelDownloader({
        modelUri: DEFAULT_LLAMA_CPP_MODEL_URI,
        dirPath: cacheDir,
        fileName: DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
        showCliProgress: false,
        onProgress: ({ downloadedSize, totalSize }) => {
          const expectedSize = totalSize || DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES;
          const percent = Math.min(100, Math.floor((downloadedSize / expectedSize) * 100));
          progress.update(`Downloading Qwen3 4B model… ${percent}%`);
        },
      });
      await downloader.download({ signal: ctx.signal });
      progress.stop("Qwen3 4B model downloaded");
    } catch (error) {
      progress.stop("Model download failed");
      throw new Error(formatLlamaCppSetupError(error), { cause: error });
    }
  }
  return buildSetupResult(ctx.config);
}
