import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  LLAMA_CPP_PROVIDER_ID,
  buildLlamaCppProviderConfig,
  resolveLlamaCppDataDir,
  resolveLlamaCppModelCacheDir,
} from "./defaults.js";
import { detectLlamaCppHardware, formatLlamaCppMemory } from "./hardware.js";
import {
  ensureLlamaServerInstalled,
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
} from "./llama-server-install.js";
import type { ManagedLlamaModel } from "./llama-server-preset.js";
import {
  ensureLlamaCppModel,
  prepareManagedLlamaServer,
  resolveLlamaCppPresetPath,
} from "./managed-server.js";
import {
  LLAMA_CPP_MEDIA_RECIPES,
  recommendLlamaCppMedia,
  type LlamaCppMediaRecipe,
} from "./media-catalog.js";
import {
  LLAMA_CPP_MEDIA_MAX_BYTES,
  LLAMA_CPP_MEDIA_MAX_CHARS,
  LLAMA_CPP_MEDIA_TIMEOUT_MS,
  isManagedLlamaCppMediaProvider,
} from "./media-config.js";
import { LLAMA_CPP_OCR_FIXTURE, LLAMA_CPP_VISION_FIXTURE } from "./media-verification-fixtures.js";

function modelDefinition(
  recipe: LlamaCppMediaRecipe,
  device: string,
  baseUrl: string,
): ModelDefinitionConfig {
  return {
    id: recipe.id,
    name: recipe.name,
    api: "openai-completions",
    // Config persistence merges model rows by id. Explicitly replace an old
    // per-model endpoint so a verified local candidate cannot publish remotely.
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: recipe.contextSize,
    contextTokens: recipe.contextSize,
    maxTokens: recipe.maxTokens,
    params: {
      modelPath: recipe.model.source,
      mmprojPath: recipe.projector.source,
      contextSize: recipe.contextSize,
      imageMaxTokens: recipe.imageMaxTokens,
      device,
    },
    compat: { supportsTools: false, supportsUsageInStreaming: true },
  };
}

export async function runLlamaCppMediaSetup(
  ctx: ProviderAuthContext,
  mediaProvider: MediaUnderstandingProvider,
): Promise<ProviderAuthResult> {
  ctx.signal?.throwIfAborted();
  if (ctx.credentialOnly) {
    throw new Error(
      "Local media setup installs and activates image routes. Run models auth login without --credential-only to complete setup.",
    );
  }
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (
    existing &&
    (!isManagedLlamaCppMediaProvider(existing) || !resolveLlamaCppPresetPath(existing.localService))
  ) {
    throw new Error(
      "Local media setup requires a managed llama.cpp router with a direct loopback endpoint and no explicit proxy. Add the server address to NO_PROXY when using an environment proxy. Your existing server is unchanged; configure managed server ownership first.",
    );
  }
  const previousMedia = ctx.config.tools?.media;
  // Untagged entries infer capabilities from another plugin's runtime. Do not guess
  // those capabilities or accidentally retain a remote image fallback.
  if (previousMedia?.models?.some((entry) => !entry.capabilities?.length)) {
    throw new Error(
      "Add explicit capabilities to your existing tools.media.models entries before local media setup, so audio/video routes can be preserved without a remote image fallback.",
    );
  }
  if (!mediaProvider.describeImage) {
    throw new Error(
      "The llama.cpp image provider is unavailable. Enable the llama-cpp plugin and retry.",
    );
  }
  const cacheDir = resolveLlamaCppModelCacheDir(existing);
  const hardware = await detectLlamaCppHardware({ cacheDir, signal: ctx.signal });
  if (hardware.platform !== "linux" || hardware.arch !== "x64") {
    await ctx.prompter.note(
      `Automatic local OCR and vision setup currently supports Linux x64 with CPU execution only; this Gateway is ${hardware.platform}/${hardware.arch}. Existing llama.cpp chat and embedding setup is unchanged.`,
      "Local media unavailable",
    );
    return { profiles: [] };
  }
  const asset = selectLlamaServerAsset(hardware.platform, hardware.arch, { kind: "cpu" });
  const degraded =
    hardware.accelerator.kind === "cpu"
      ? undefined
      : "Initial local media support uses CPU execution even when an accelerator is detected.";
  const cached = new Map<string, string>();
  for (const recipe of LLAMA_CPP_MEDIA_RECIPES) {
    for (const artifact of [recipe.model, recipe.projector]) {
      const file = await ensureLlamaCppModel({
        source: artifact.source,
        cacheDir,
        download: false,
        signal: ctx.signal,
      }).catch(() => {
        ctx.signal?.throwIfAborted();
        return undefined;
      });
      if (file) {
        cached.set(artifact.expectedSha256, file);
      }
    }
  }
  const runtimeCached = await fs
    .stat(resolveManagedLlamaServerPaths(asset).command)
    .then((stat) => stat.isFile())
    .catch(() => false);
  const recommendation = recommendLlamaCppMedia(hardware, asset.backend, {
    artifactSha256: new Set(cached.keys()),
    runtime: runtimeCached,
  });
  if (recommendation.kind === "unavailable") {
    await ctx.prompter.note(
      [
        recommendation.reason,
        ...recommendation.rejections.map((item) => `${item.id}: ${item.reasons.join(" ")}`),
      ].join("\n"),
      "Local media unavailable",
    );
    return { profiles: [] };
  }
  const recipes = [recommendation.ocr, recommendation.vision];
  const artifacts = [
    ...new Map(
      recipes
        .flatMap((recipe) => [recipe.model, recipe.projector])
        .map((artifact) => [artifact.expectedSha256, artifact]),
    ).values(),
  ];
  const runtimeBytes = [asset, ...(asset.dependencies ?? [])].reduce(
    (total, archive) => total + (archive.sizeBytes ?? 0),
    0,
  );
  const downloads = artifacts.filter((artifact) => !cached.has(artifact.expectedSha256));
  const consent = await ctx.prompter.confirm({
    initialValue: false,
    message: [
      `Gateway host: ${os.hostname()} (${hardware.platform}/${hardware.arch})`,
      `Backend: ${asset.backend.toUpperCase()}`,
      degraded ?? (hardware.accelerator.kind === "cpu" ? hardware.accelerator.reason : undefined),
      `RAM: ${formatLlamaCppMemory(hardware.totalMemoryBytes)} total, ${formatLlamaCppMemory(hardware.availableMemoryBytes)} available.`,
      `Disk: ${formatLlamaCppMemory(hardware.availableDiskBytes ?? 0)} model volume; ${formatLlamaCppMemory(hardware.availableRuntimeDiskBytes ?? 0)} runtime volume (${hardware.sharedDisk ? "shared budget" : "separate budgets"}).`,
      recommendation.reason,
      ...recipes.flatMap((recipe) => [
        `${recipe.capability.toUpperCase()}: ${recipe.name}`,
        ...recipe.limitations,
      ]),
      ...artifacts.map(
        (artifact) =>
          `${artifact.filename}: ${formatLlamaCppMemory(artifact.expectedSize)}${cached.has(artifact.expectedSha256) ? " (verified cache)" : " download"}`,
      ),
      `llama.cpp runtime: ${runtimeBytes.toLocaleString()} bytes${runtimeCached ? " (cached; version will be verified)" : " download"}.`,
      `Total download: ${formatLlamaCppMemory(downloads.reduce((total, artifact) => total + artifact.expectedSize, 0) + (runtimeCached ? 0 : runtimeBytes))}; required free disk including runtime staging: ${formatLlamaCppMemory(recommendation.requiredDiskBytes)}.`,
      ...recommendation.rejections.map((item) => `Rejected ${item.id}: ${item.reasons.join(" ")}`),
      "Load one model at a time; switching between chat, embeddings, OCR and vision may add latency. Existing chat defaults, inventory and embeddings are preserved.",
      "Replace image-understanding routes and the image tool default with local vision, without remote fallbacks. OCR is selected explicitly with local_image task=ocr; ambiguous tasks use vision.",
      "These image inference routes stay local. Original images remain available; an existing cloud chat model can still receive them under its normal native-vision policy.",
      "Download, verify real OCR and spatial image understanding, then activate?",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  ctx.signal?.throwIfAborted();
  if (!consent) {
    return { profiles: [] };
  }
  const progress = ctx.prompter.progress("Preparing local OCR and vision…");
  let presetPath: string | undefined;
  let verificationDir: string | undefined;
  let verified = false;
  try {
    ctx.assertCurrent?.();
    await ensureLlamaServerInstalled({ asset, signal: ctx.signal });
    const device = "none";
    for (const artifact of artifacts) {
      ctx.assertCurrent?.();
      const file = await ensureLlamaCppModel({
        source: artifact.source,
        cacheDir,
        download: true,
        signal: ctx.signal,
        onProgress: (status) =>
          progress.update(
            `${artifact.filename}: ${Math.floor((100 * status.downloadedSize) / Math.max(1, status.totalSize))}%`,
          ),
      });
      cached.set(artifact.expectedSha256, file);
    }
    const mediaModels: ManagedLlamaModel[] = recipes.map((recipe) => {
      const modelPath = cached.get(recipe.model.expectedSha256);
      const projectorPath = cached.get(recipe.projector.expectedSha256);
      if (!modelPath || !projectorPath) {
        throw new Error(`Missing verified model or projector for ${recipe.name}. Retry setup.`);
      }
      return {
        id: recipe.id,
        path: modelPath,
        projectorPath,
        contextSize: recipe.contextSize,
        maxTokens: recipe.maxTokens,
        imageMaxTokens: recipe.imageMaxTokens,
        device,
      };
    });
    const managed = await prepareManagedLlamaServer({
      chatModel: { mode: "preserve" },
      mediaModels,
      modelsMax: 1,
      localService: existing?.localService,
      asset,
      isolated: true,
      signal: ctx.signal,
    });
    presetPath = resolveLlamaCppPresetPath(managed);
    const selectedIds = new Set(recipes.map((recipe) => recipe.id));
    const provider = buildLlamaCppProviderConfig({
      existing,
      managed,
      modelInventory: [
        ...(existing?.models ?? []).filter((model) => !selectedIds.has(model.id)),
        ...recipes.map((recipe) => modelDefinition(recipe, device, managed.baseUrl)),
      ],
    });
    provider.params = {
      ...existing?.params,
      mediaModels: { ocr: recommendation.ocr.id, vision: recommendation.vision.id },
    };
    const configPatch: NonNullable<ProviderAuthResult["configPatch"]> = {
      models: {
        ...ctx.config.models,
        providers: { ...ctx.config.models?.providers, [LLAMA_CPP_PROVIDER_ID]: provider },
      },
      agents: {
        ...ctx.config.agents,
        defaults: {
          ...ctx.config.agents?.defaults,
          imageModel: {
            primary: `${LLAMA_CPP_PROVIDER_ID}/${recommendation.vision.id}`,
            fallbacks: [],
          },
        },
      },
      tools: {
        ...ctx.config.tools,
        media: {
          ...previousMedia,
          models: [
            ...(previousMedia?.models ?? []).flatMap((entry) => {
              const capabilities = entry.capabilities?.filter(
                (capability) => capability !== "image",
              );
              return capabilities?.length ? [{ ...entry, capabilities }] : [];
            }),
            {
              provider: LLAMA_CPP_PROVIDER_ID,
              model: recommendation.vision.id,
              capabilities: ["image"],
            },
          ],
          image: {
            ...previousMedia?.image,
            enabled: true,
            maxBytes: previousMedia?.image?.maxBytes ?? LLAMA_CPP_MEDIA_MAX_BYTES,
            maxChars: previousMedia?.image?.maxChars ?? LLAMA_CPP_MEDIA_MAX_CHARS,
            timeoutSeconds:
              previousMedia?.image?.timeoutSeconds ?? LLAMA_CPP_MEDIA_TIMEOUT_MS / 1000,
          },
        },
      },
    };
    await fs.mkdir(resolveLlamaCppDataDir(), { recursive: true });
    verificationDir = await fs.mkdtemp(path.join(resolveLlamaCppDataDir(), ".media-verify-"));
    const candidateProvider: ModelProviderConfig = {
      ...provider,
      localService: { ...provider.localService, command: managed.command, idleStopMs: 1 },
    };
    const candidateConfig = {
      ...ctx.config,
      ...configPatch,
      models: {
        ...configPatch.models,
        providers: { ...configPatch.models?.providers, [LLAMA_CPP_PROVIDER_ID]: candidateProvider },
      },
    };
    for (const task of ["ocr", "vision"] as const) {
      ctx.assertCurrent?.();
      ctx.signal?.throwIfAborted();
      progress.update(`Verifying real ${task.toUpperCase()} inference…`);
      const response = await mediaProvider.describeImage({
        cfg: candidateConfig,
        agentDir: verificationDir,
        provider: LLAMA_CPP_PROVIDER_ID,
        model: recommendation[task].id,
        buffer: task === "ocr" ? LLAMA_CPP_OCR_FIXTURE : LLAMA_CPP_VISION_FIXTURE,
        fileName: `${task}-verification.png`,
        mime: "image/png",
        prompt:
          task === "ocr"
            ? "Transcribe the visible text."
            : "Which shape is above the blue circle? Answer with its color and shape.",
        maxTokens: 64,
        timeoutMs: Math.min(
          LLAMA_CPP_MEDIA_TIMEOUT_MS,
          (previousMedia?.image?.timeoutSeconds ?? LLAMA_CPP_MEDIA_TIMEOUT_MS / 1000) * 1000,
        ),
        signal: ctx.signal,
      });
      ctx.signal?.throwIfAborted();
      const passed =
        task === "ocr"
          ? /\bOPENCLAW\s+OCR\s+4827\b/iu.test(response.text)
          : /\bred\s+square\b/iu.test(response.text) &&
            !/\b(?:not|no|below)\b/iu.test(response.text);
      if (!passed) {
        throw new Error(
          `${task.toUpperCase()} inference verification failed for ${recommendation[task].name}. Existing configuration is unchanged. Retry setup or review model limitations.`,
        );
      }
    }
    ctx.assertCurrent?.();
    ctx.signal?.throwIfAborted();
    verified = true;
    progress.stop("Local OCR and vision verified");
    return {
      profiles: [],
      configPatch,
      notes: [
        "Local OCR and vision passed real image checks. Use local_image task=ocr for transcription or task=vision for visual questions. Existing chat defaults and embeddings are unchanged.",
      ],
    };
  } catch (error) {
    progress.stop("Local media setup failed; previous configuration retained");
    throw error;
  } finally {
    // Shared media runtime releases its service lease after each probe (also on
    // cancellation). Its idle policy owns process shutdown; no second supervisor.
    if (!verified && presetPath) {
      await fs.rm(presetPath, { force: true });
    }
    if (verificationDir) {
      await fs.rm(verificationDir, { recursive: true, force: true });
    }
  }
}
