import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ImageGenerationSourceImage } from "openclaw/plugin-sdk/image-generation";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
} from "openclaw/plugin-sdk/image-generation-runtime";
import type { OpenClawPluginApi } from "../api.js";
import type { OpenClawConfig } from "../api.js";
import type { ResolvedBookWriterConfig } from "./config.js";
import { readJsonFile, resolveRunPaths } from "./files.js";
import { normalizeKdpCoverStrategy, prepareKdpDryRun } from "./kdp-dry-run.js";
import { readBenchRecords } from "./model-governor.js";
import { runBookWriterPipeline } from "./pipeline.js";
import {
  approveBookPlanCover,
  archiveBookPlan,
  buildBookPlanQualityReport,
  createAndSaveBookPlan,
  createQuickReadAndSave,
  deleteArchivedBookPlan,
  deleteBookPlan,
  deleteBookPlans,
  deleteDeletedBookPlan,
  draftAndSaveBookPlan,
  draftAndSaveBookPlanParagraph,
  emptyDeletedBookPlans,
  fillAndSaveParagraphPlanFields,
  finishBookPlan,
  generateAndSaveChapterSetup,
  generateAndSaveIdeaSetup,
  generateAndSaveBookPlanCoverConcept,
  bookWriterGenerationModel,
  listPenNameProfiles,
  listArchivedBookPlanProjects,
  listDeletedBookPlanProjects,
  listFinishedBookPlanProjects,
  listBookPlanProjects,
  looksLikeInstructionalBookText,
  copyBookPlan,
  readBookPlan,
  readManuscriptPreview,
  readReviewPack,
  recommendNextBookFromPublishedBooks,
  rebalanceAndSaveBookPlan,
  reorderChapter,
  reorderParagraph,
  propagateAndSaveStoryImpact,
  restoreArchivedBookPlan,
  restoreDeletedBookPlan,
  restoreFinishedBookPlan,
  saveBookPlan,
  suggestBookPlanFieldWithContext,
  suggestBookSetupTopicWithContext,
  stitchAndSaveBookPlan,
  updatePenNameProfile,
  updatePublishedBookMetrics,
  uploadBookPlanCover,
} from "./planning.js";
import { disableBookWriterAutomation, readBookWriterAutomationStatus } from "./scheduler.js";
import type {
  BookPlan,
  BookWriterChapterSetupTarget,
  BookWriterAiHelpIntent,
  BookWriterAiHelpTarget,
  BookWriterIdeaSetupTarget,
  BookPlanProfanityLevel,
  BookPlanTonePreset,
  BookWriterDashboardSnapshot,
  BookWriterLocalAiHealth,
  BookWriterLocalCoverAiStatus,
  KdpDryRunReport,
  ModelBenchRecord,
  PublishedBookMetrics,
  PublishedBookProof,
  ReviewPack,
} from "./types.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const APPROVAL_SCOPE = "operator.approvals" as const;

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];

function respondError(respond: GatewayRespond, error: unknown) {
  respond(false, undefined, {
    code: "internal_error",
    message: formatErrorMessage(error),
  });
}

function aiHelpIntentParam(params: Record<string, unknown>): BookWriterAiHelpIntent {
  const value = stringParam(params, "intent") ?? "improve";
  if (
    value === "fill" ||
    value === "improve" ||
    value === "shorten" ||
    value === "clearer" ||
    value === "dramatic" ||
    value === "humorous" ||
    value === "custom"
  ) {
    return value;
  }
  throw new Error("intent is invalid.");
}

function aiHelpTargetParam(params: Record<string, unknown>): BookWriterAiHelpTarget {
  const value = stringParam(params, "target", true);
  if (
    value === "bookStyle" ||
    value === "title" ||
    value === "topic" ||
    value === "audience" ||
    value === "readerPromise" ||
    value === "chapterTitle" ||
    value === "chapterDescription" ||
    value === "chapterStyle" ||
    value === "paragraphTitle" ||
    value === "paragraphSummary" ||
    value === "paragraphPlan" ||
    value === "paragraphStyle" ||
    value === "paragraphText" ||
    value === "coverBrief" ||
    value === "coverPrompt"
  ) {
    return value;
  }
  throw new Error("target is invalid.");
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined;
function stringParam(params: Record<string, unknown>, key: string, required: true): string;
function stringParam(
  params: Record<string, unknown>,
  key: string,
  required?: true,
): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (required) {
    throw new Error(`${key} is required.`);
  }
  return undefined;
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringArrayParam(params: Record<string, unknown>, key: string, required: true): string[] {
  const value = params[key];
  if (Array.isArray(value)) {
    const strings = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    if (strings.length) {
      return [...new Set(strings)];
    }
  }
  if (required) {
    throw new Error(`${key} is required.`);
  }
  return [];
}

function optionalStringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return strings.length ? [...new Set(strings)] : undefined;
}

function directionParam(params: Record<string, unknown>): "up" | "down" {
  const value = stringParam(params, "direction");
  if (value === "up" || value === "down") {
    return value;
  }
  throw new Error("direction must be up or down.");
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function objectParam<T extends object>(
  params: Record<string, unknown>,
  key: string,
): Partial<T> | undefined {
  const value = params[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Partial<T>;
  }
  return undefined;
}

function tonePresetParam(
  params: Record<string, unknown>,
  key: string,
): BookPlanTonePreset | undefined {
  const value = stringParam(params, key);
  if (
    value === "professional" ||
    value === "technical" ||
    value === "conversational" ||
    value === "humorous" ||
    value === "dramatic" ||
    value === "literary" ||
    value === "inspirational" ||
    value === "direct" ||
    value === "custom"
  ) {
    return value;
  }
  return undefined;
}

function profanityLevelParam(
  params: Record<string, unknown>,
  key: string,
): BookPlanProfanityLevel | undefined {
  const value = stringParam(params, key);
  if (
    value === "none" ||
    value === "mild" ||
    value === "moderate" ||
    value === "high" ||
    value === "extreme"
  ) {
    return value;
  }
  return undefined;
}

function bookPlanParam(params: Record<string, unknown>): BookPlan {
  const value = params.plan;
  if (!value || typeof value !== "object") {
    throw new Error("plan is required.");
  }
  const plan = value as BookPlan;
  if (typeof plan.runId !== "string" || !plan.runId.trim()) {
    throw new Error("plan.runId is required.");
  }
  if (!Array.isArray(plan.chapters)) {
    throw new Error("plan.chapters must be an array.");
  }
  return plan;
}

async function readKdpDryRun(
  config: ResolvedBookWriterConfig,
  runId: string,
): Promise<KdpDryRunReport | null> {
  const paths = resolveRunPaths(config.outputDir, runId);
  return (
    (await readJsonFile<KdpDryRunReport>(path.join(paths.runDir, "kdp-dry-run-report.json"))) ??
    null
  );
}

function localAiBaseUrl(config: ResolvedBookWriterConfig): string {
  const baseUrl = config.localBaseUrl.replace(/\/$/, "");
  if (config.localProvider === "ollama") {
    return baseUrl.replace(/\/v1$/i, "");
  }
  return baseUrl;
}

async function fetchJsonWithTimeout(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function modelName(value: unknown): string | null {
  if (value && typeof value === "object") {
    const record = value as { name?: unknown; model?: unknown; id?: unknown };
    if (typeof record.name === "string" && record.name.trim()) {
      return record.name.trim();
    }
    if (typeof record.model === "string" && record.model.trim()) {
      return record.model.trim();
    }
    if (typeof record.id === "string" && record.id.trim()) {
      return record.id.trim();
    }
  }
  return null;
}

function listedModels(json: unknown): string[] {
  if (!json || typeof json !== "object") {
    return [];
  }
  const record = json as { models?: unknown; data?: unknown };
  const items = Array.isArray(record.models)
    ? record.models
    : Array.isArray(record.data)
      ? record.data
      : [];
  return items.flatMap((item) => {
    const name = modelName(item);
    return name ? [name] : [];
  });
}

function hasModel(models: string[], model: string): boolean {
  return models.some((candidate) => candidate === model || candidate.startsWith(`${model}:`));
}

async function latestBenchmark(
  config: ResolvedBookWriterConfig,
): Promise<ModelBenchRecord | undefined> {
  const records = await readBenchRecords(config.outputDir);
  return records
    .filter(
      (record) => record.provider === config.localProvider && record.model === config.localModel,
    )
    .toSorted((left, right) => {
      if (left.source === "measured" && right.source !== "measured") {
        return -1;
      }
      if (right.source === "measured" && left.source !== "measured") {
        return 1;
      }
      return right.measuredAt.localeCompare(left.measuredAt);
    })[0];
}

async function readLocalAiHealth(params: {
  config: ResolvedBookWriterConfig;
  fetchImpl?: typeof fetch;
}): Promise<BookWriterLocalAiHealth> {
  const provider = params.config.localProvider;
  const model = params.config.localModel;
  const baseUrl = localAiBaseUrl(params.config);
  const checkedAt = new Date().toISOString();
  const fetcher = params.fetchImpl ?? fetch;
  const benchmark = await latestBenchmark(params.config).catch(() => undefined);
  const benchmarkSummary = benchmark
    ? {
        source: benchmark.source,
        tokensPerSecond: benchmark.tokensPerSecond,
        peakMemoryGb: benchmark.peakMemoryGb,
        qualityScore: benchmark.qualityScore,
        measuredAt: benchmark.measuredAt,
      }
    : undefined;

  try {
    if (provider === "ollama") {
      const tags = listedModels(await fetchJsonWithTimeout(fetcher, `${baseUrl}/api/tags`));
      const ps = listedModels(
        await fetchJsonWithTimeout(fetcher, `${baseUrl}/api/ps`).catch(() => ({})),
      );
      const modelAvailable = hasModel(tags, model);
      const modelLoaded = hasModel(ps, model);
      const status: BookWriterLocalAiHealth["status"] = modelAvailable ? "ready" : "model-missing";
      return {
        status,
        provider,
        model,
        baseUrl,
        reachable: true,
        modelAvailable,
        modelLoaded,
        message: modelAvailable
          ? modelLoaded
            ? "Local AI is connected and the selected model is warm."
            : "Local AI is connected. The selected model is installed but not warm yet."
          : "Ollama is reachable, but the selected Book Writer model is not installed.",
        lastCheckedAt: checkedAt,
        benchmark: benchmarkSummary,
        guidance: modelAvailable
          ? modelLoaded
            ? ["You can use Book Publisher AI buttons now."]
            : [`Click an AI write button or run \`ollama run ${model}\` once to warm the model.`]
          : [`Install the model with \`ollama pull ${model}\`, then refresh Book Publisher.`],
      };
    }

    const models = listedModels(await fetchJsonWithTimeout(fetcher, `${baseUrl}/models`));
    const modelAvailable =
      provider === "custom"
        ? models.length === 0 || hasModel(models, model)
        : hasModel(models, model);
    return {
      status: modelAvailable ? "ready" : "model-missing",
      provider,
      model,
      baseUrl,
      reachable: true,
      modelAvailable,
      modelLoaded: modelAvailable,
      message: modelAvailable
        ? "Local AI is connected and the selected Book Writer model is available."
        : "Local AI is reachable, but the selected Book Writer model was not listed.",
      lastCheckedAt: checkedAt,
      benchmark: benchmarkSummary,
      guidance: modelAvailable
        ? ["You can use Book Publisher AI buttons now."]
        : ["Load the selected model in the local AI server, then refresh Book Publisher."],
    };
  } catch (error) {
    return {
      status: "unreachable",
      provider,
      model,
      baseUrl,
      reachable: false,
      modelAvailable: false,
      modelLoaded: false,
      message: "Local AI is not reachable from Book Publisher.",
      lastCheckedAt: checkedAt,
      lastError: formatErrorMessage(error),
      benchmark: benchmarkSummary,
      guidance:
        provider === "ollama"
          ? ["Start Ollama, confirm `ollama list` shows the model, then refresh Book Publisher."]
          : ["Start the configured local AI server, load the model, then refresh Book Publisher."],
    };
  }
}

function configuredImageModelRef(appConfig: OpenClawConfig): string | undefined {
  const model = appConfig.agents?.defaults?.imageGenerationModel;
  if (typeof model === "string") {
    return model.trim() || undefined;
  }
  return typeof model?.primary === "string" && model.primary.trim()
    ? model.primary.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function localComfyImageConfig(appConfig: OpenClawConfig): Record<string, unknown> {
  const pluginConfig: unknown = appConfig.plugins?.entries?.comfy?.config;
  const legacyConfig: unknown = appConfig.models?.providers?.comfy;
  const config = isRecord(pluginConfig) ? pluginConfig : isRecord(legacyConfig) ? legacyConfig : {};
  const nested = config.image;
  return isRecord(nested) ? { ...config, ...nested } : config;
}

function localComfyBaseUrl(appConfig: OpenClawConfig): string {
  return configString(localComfyImageConfig(appConfig), "baseUrl") ?? "http://127.0.0.1:8188";
}

async function localComfyReachable(
  appConfig: OpenClawConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const baseUrl = localComfyBaseUrl(appConfig).replace(/\/$/, "");
  try {
    const response = await fetchImpl(`${baseUrl}/system_stats`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

function extensionForMimeType(mimeType: string | undefined): string {
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  if (mimeType === "image/svg+xml") {
    return ".svg";
  }
  return ".png";
}

function coverMimeTypeForPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return undefined;
}

async function readCoverVariantPreviewDataUrl(variant: BookPlan["cover"]["variants"][number]) {
  if (!variant.path) {
    return undefined;
  }
  const mimeType = variant.mimeType ?? coverMimeTypeForPath(variant.path);
  if (!mimeType?.startsWith("image/")) {
    return undefined;
  }
  try {
    const buffer = await fs.readFile(variant.path);
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function withCoverPreviewDataUrls(plan: BookPlan | null): Promise<BookPlan | null> {
  if (!plan) {
    return null;
  }
  const variants = await Promise.all(
    plan.cover.variants.map(async (variant) => ({
      ...variant,
      previewDataUrl: variant.previewDataUrl ?? (await readCoverVariantPreviewDataUrl(variant)),
    })),
  );
  return {
    ...plan,
    cover: {
      ...plan.cover,
      variants,
    },
  };
}

async function readLocalCoverAiStatus(
  appConfig: OpenClawConfig,
  fetchImpl?: typeof fetch,
): Promise<BookWriterLocalCoverAiStatus> {
  const checkedAt = new Date().toISOString();
  const providers = listRuntimeImageGenerationProviders({ config: appConfig });
  const comfy = providers.find((provider) => provider.id === "comfy");
  const configuredRef = configuredImageModelRef(appConfig);
  const comfyConfig = localComfyImageConfig(appConfig);
  const missingComfyConfig = [
    configuredRef === "comfy/workflow"
      ? null
      : "Set agents.defaults.imageGenerationModel.primary to comfy/workflow.",
    configString(comfyConfig, "workflowPath") || comfyConfig.workflow
      ? null
      : "Configure plugins.entries.comfy.config.image.workflowPath.",
    configString(comfyConfig, "promptNodeId")
      ? null
      : "Configure plugins.entries.comfy.config.image.promptNodeId.",
    configString(comfyConfig, "outputNodeId")
      ? null
      : "Configure plugins.entries.comfy.config.image.outputNodeId.",
  ].filter((item): item is string => Boolean(item));
  if (!comfy) {
    return {
      status: "setup-needed",
      message: "Local image AI is not configured. Enable the bundled ComfyUI plugin first.",
      guidance: [
        "Enable the comfy plugin.",
        "Start ComfyUI locally, usually at http://127.0.0.1:8188.",
        "Configure agents.defaults.imageGenerationModel.primary as comfy/workflow.",
      ],
      checkedAt,
    };
  }
  const configured = comfy.isConfigured?.({ cfg: appConfig }) ?? Boolean(configuredRef);
  if (!configured || missingComfyConfig.length > 0) {
    return {
      status: "fallback",
      provider: "comfy",
      model: configuredRef,
      message:
        "Local image AI is not ready yet. Book Studio can still create an editable SVG cover concept.",
      guidance: [
        ...missingComfyConfig,
        "Start ComfyUI locally before generating a real cover image.",
      ],
      checkedAt,
    };
  }
  if (!(await localComfyReachable(appConfig, fetchImpl))) {
    return {
      status: "setup-needed",
      provider: "comfy",
      model: "comfy/workflow",
      message: `ComfyUI is configured but not reachable at ${localComfyBaseUrl(appConfig)}.`,
      guidance: [
        "Start ComfyUI locally.",
        "Confirm the ComfyUI server URL is reachable.",
        "Then click Generate Local AI Cover again.",
      ],
      checkedAt,
    };
  }
  return {
    status: "ready",
    provider: "comfy",
    model: "comfy/workflow",
    message: "Local image AI is ready through ComfyUI.",
    guidance: ["Generate a local AI cover, then approve the best variant before publishing prep."],
    checkedAt,
  };
}

function coverArtPromptForPlan(plan: BookPlan): string {
  const chapterContext = plan.chapters
    .slice(0, 6)
    .map((chapter) => `Chapter ${chapter.number}: ${chapter.title} — ${chapter.description}`)
    .join("\n");
  return [
    "Book Writer specialized job: cover-art-director.",
    "Create a professional commercial book cover image.",
    `Title: ${plan.title}`,
    plan.subtitle ? `Subtitle: ${plan.subtitle}` : "",
    `Author / pen name: ${plan.penName}`,
    `Genre: ${plan.genre}`,
    `Reader promise: ${plan.brief.readerPromise}`,
    `Tone: ${plan.styleGuide?.toneDescription ?? plan.brief.tone}`,
    `Cover brief: ${plan.cover.brief}`,
    `Operator prompt: ${plan.cover.prompt}`,
    chapterContext ? `Book context:\n${chapterContext}` : "",
    "Design requirements: strong thumbnail readability, original imagery, clean title space, polished typography, no trademarked imagery, no planning text, no mockup frame.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateAndSaveLocalAiCoverImage(params: {
  config: ResolvedBookWriterConfig;
  appConfig: OpenClawConfig;
  runId: string;
  baseVersion?: number;
  instruction?: string;
  referenceVariantId?: string;
}): Promise<BookPlan> {
  const existing = await readBookPlan(params.config, params.runId);
  if (!existing) {
    throw new Error(`book plan not found: ${params.runId}`);
  }
  if (params.baseVersion !== undefined && existing.version !== params.baseVersion) {
    throw new Error(
      `book plan version conflict: expected ${params.baseVersion}, found ${existing.version}`,
    );
  }
  const localStatus = await readLocalCoverAiStatus(params.appConfig);
  if (localStatus.status !== "ready") {
    return generateAndSaveBookPlanCoverConcept({
      config: params.config,
      runId: params.runId,
      baseVersion: params.baseVersion,
    });
  }
  const referenceVariant = params.referenceVariantId
    ? existing.cover.variants.find((variant) => variant.id === params.referenceVariantId)
    : (existing.cover.variants.find((variant) => variant.approved) ?? existing.cover.variants[0]);
  const inputImages: ImageGenerationSourceImage[] = [];
  if (params.instruction && referenceVariant?.path) {
    const mimeType = referenceVariant.mimeType ?? coverMimeTypeForPath(referenceVariant.path);
    if (mimeType?.startsWith("image/")) {
      inputImages.push({
        buffer: await fs.readFile(referenceVariant.path),
        mimeType,
        fileName: path.basename(referenceVariant.path),
      });
    }
  }
  const basePrompt = coverArtPromptForPlan(existing);
  const prompt = params.instruction
    ? `${basePrompt}\n\nBook Writer specialized job: cover-image-editor.\nEdit instruction: ${params.instruction}`
    : basePrompt;
  const result = await generateImage({
    cfg: params.appConfig,
    prompt,
    modelOverride: localStatus.model ?? "comfy/workflow",
    count: 1,
    aspectRatio: "2:3",
    outputFormat: "png",
    ...(inputImages.length > 0 ? { inputImages } : {}),
    autoProviderFallback: false,
  });
  const image = result.images[0];
  if (!image) {
    throw new Error("Local image AI returned no cover image.");
  }
  const now = new Date().toISOString();
  const extension = extensionForMimeType(image.mimeType);
  const safeCreatedAt = now.replace(/[:.]/g, "-");
  const coverPath = path.join(
    resolveRunPaths(params.config.outputDir, existing.runId).runDir,
    `cover-local-ai-${safeCreatedAt}${extension}`,
  );
  await fs.writeFile(coverPath, image.buffer);
  return saveBookPlan({
    config: params.config,
    baseVersion: existing.version,
    plan: {
      ...existing,
      cover: {
        ...existing.cover,
        status: "generated",
        variants: [
          {
            id: `local-ai-${safeCreatedAt}`,
            label: "Local AI cover",
            path: coverPath,
            source: "local-ai",
            prompt: image.revisedPrompt ?? prompt,
            provider: result.provider,
            model: result.model,
            createdAt: now,
            mimeType: image.mimeType,
            approved: false,
          },
          ...existing.cover.variants,
        ],
      },
    },
    action: "cover-local-ai",
    summary: "Generated a local AI cover image with the Book Writer cover-image-generator.",
  });
}

async function buildSnapshot(params: {
  config: ResolvedBookWriterConfig;
  appConfig: OpenClawConfig;
  runId?: string;
  fetchImpl?: typeof fetch;
}): Promise<BookWriterDashboardSnapshot> {
  const projects = await listBookPlanProjects(params.config);
  const archivedBooks = await listArchivedBookPlanProjects(params.config);
  const deletedBooks = await listDeletedBookPlanProjects(params.config);
  const finishedBooks = await listFinishedBookPlanProjects(params.config);
  const penNameProfiles = await listPenNameProfiles(params.config);
  const recommendation = recommendNextBookFromPublishedBooks(finishedBooks);
  const requestedRunId = params.runId?.trim() || null;
  const rawPlan = requestedRunId
    ? ((await readBookPlan(params.config, requestedRunId)) ?? null)
    : null;
  const plan = await withCoverPreviewDataUrls(rawPlan);
  const selectedRunId = plan?.runId ?? null;
  const reviewPack = plan ? await readReviewPack(params.config, plan.runId) : null;
  const publishDryRun = plan ? await readKdpDryRun(params.config, plan.runId) : null;
  const manuscriptPreview = await readManuscriptPreview(params.config, plan);
  const planQuality = plan ? buildBookPlanQualityReport(plan) : null;
  const automation = await readBookWriterAutomationStatus(params.config);
  const localAiHealth = await readLocalAiHealth({
    config: params.config,
    fetchImpl: params.fetchImpl,
  });
  const nextActions: string[] = [];
  if (!plan) {
    nextActions.push("Create a book plan from a topic paragraph.");
  } else if (planQuality && planQuality.counts.draftedParagraphs < planQuality.counts.paragraphs) {
    nextActions.push("Generate text for empty unlocked paragraphs before packaging.");
  } else if (planQuality && planQuality.status !== "pass") {
    nextActions.push("Fix the plan quality findings before packaging.");
  } else if (!plan.artifactLinks.manuscript) {
    nextActions.push("Build the manuscript by stitching paragraph text into manuscript.md.");
  } else if (!reviewPack) {
    nextActions.push("Package and run gates for the review pack.");
  } else if (reviewPack.recommendation !== "approve") {
    nextActions.push(
      `Review pack is ${reviewPack.recommendation}; fix gaps and re-run Check package before KDP prep.`,
    );
  } else if (!publishDryRun) {
    nextActions.push("Prepare the approval-gated KDP upload plan.");
  } else if (publishDryRun.status !== "ready") {
    nextActions.push("Fix KDP dry-run blockers before opening the KDP upload flow.");
  } else {
    nextActions.push(
      "Open KDP, follow the upload checklist, stop before final submit, then move the completed book to the Trophy Room.",
    );
  }
  return {
    generatedAt: new Date().toISOString(),
    outputDir: params.config.outputDir,
    projects,
    archivedBooks,
    deletedBooks,
    finishedBooks,
    penNameProfiles,
    recommendation,
    selectedRunId,
    plan,
    manuscriptPreview,
    planQuality,
    reviewPack,
    publishDryRun,
    automation,
    generationModel: bookWriterGenerationModel(params.config),
    localAiHealth,
    localCoverAiStatus: await readLocalCoverAiStatus(params.appConfig, params.fetchImpl),
    nextActions,
  };
}

async function packagePlan(params: {
  config: ResolvedBookWriterConfig;
  runId: string;
  baseVersion?: number;
}): Promise<{ plan: BookPlan; reviewPack: ReviewPack }> {
  let plan = await readBookPlan(params.config, params.runId);
  if (!plan) {
    throw new Error(`book plan not found: ${params.runId}`);
  }
  if (params.baseVersion !== undefined && plan.version !== params.baseVersion) {
    throw new Error(
      `book plan version conflict: expected ${params.baseVersion}, found ${plan.version}`,
    );
  }
  const missingParagraphs = plan.chapters
    .flatMap((chapter) =>
      chapter.paragraphs.map((paragraph) => ({
        chapter,
        paragraph,
      })),
    )
    .filter(({ paragraph }) => !paragraph.text.trim());
  const needsReaderTextRepair = plan.chapters
    .flatMap((chapter) => chapter.paragraphs)
    .some((paragraph) => !paragraph.locked && looksLikeInstructionalBookText(paragraph.text));
  if (missingParagraphs.length || needsReaderTextRepair) {
    const firstMissing = missingParagraphs[0];
    throw new Error(
      firstMissing
        ? `Book Text is missing in chapter ${firstMissing.chapter.number}, paragraph ${firstMissing.paragraph.order}. Click Write missing Book Text before checking or packaging.`
        : "Some Book Text still looks like planning instructions. Repair it before checking or packaging.",
    );
  }
  const stitched = await stitchAndSaveBookPlan({
    config: params.config,
    runId: params.runId,
    baseVersion: plan.version,
  });
  const reviewPack = await runBookWriterPipeline({
    config: params.config,
    request: {
      runId: params.runId,
      topic: stitched.plan.topic,
      genre: stitched.plan.genre,
      penName: stitched.plan.penName,
      targetWords: stitched.plan.targetWords,
      tone: stitched.plan.styleGuide?.toneDescription ?? stitched.plan.brief.tone,
      tonePreset: stitched.plan.styleGuide?.tonePreset,
      profanityLevel: stitched.plan.styleGuide?.profanityLevel,
      liveModel: false,
    },
    stages: "review-pack",
  });
  const packaged = await saveBookPlan({
    config: params.config,
    baseVersion: stitched.plan.version,
    plan: {
      ...stitched.plan,
      status: reviewPack.recommendation === "approve" ? "publish-ready" : "packaged",
      artifactLinks: {
        ...stitched.plan.artifactLinks,
        ...reviewPack.artifacts,
        reviewPack: path.join(
          resolveRunPaths(params.config.outputDir, params.runId).runDir,
          "review-pack.json",
        ),
      },
    },
    action: "package",
    summary: "Packaged review pack, export assets, and gate reports.",
  });
  return { plan: packaged, reviewPack };
}

async function fixPlan(params: {
  config: ResolvedBookWriterConfig;
  runId: string;
  baseVersion?: number;
}): Promise<{ plan: BookPlan; reviewPack: ReviewPack }> {
  const plan = await readBookPlan(params.config, params.runId);
  if (!plan) {
    throw new Error(`book plan not found: ${params.runId}`);
  }
  if (params.baseVersion !== undefined && plan.version !== params.baseVersion) {
    throw new Error(
      `book plan version conflict: expected ${params.baseVersion}, found ${plan.version}`,
    );
  }
  const drafted = await draftAndSaveBookPlan({
    config: params.config,
    runId: params.runId,
    baseVersion: plan.version,
  });
  return packagePlan({
    config: params.config,
    runId: params.runId,
    baseVersion: drafted.version,
  });
}

export function registerBookWriterGatewayMethods(params: {
  api: OpenClawPluginApi;
  config: ResolvedBookWriterConfig;
  fetchImpl?: typeof fetch;
}) {
  const { api, config, fetchImpl } = params;
  const appConfig = api.config ?? {};
  const snapshotParams = { config, appConfig, fetchImpl };

  api.registerGatewayMethod(
    "bookWriter.dashboard.snapshot",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await buildSnapshot({ ...snapshotParams, runId: stringParam(requestParams, "runId") }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.create",
    async ({ params: requestParams, respond }) => {
      try {
        const topic = stringParam(requestParams, "topic", true);
        const plan = await createAndSaveBookPlan({
          config,
          request: {
            topic,
            genre: stringParam(requestParams, "genre"),
            penName: stringParam(requestParams, "penName"),
            targetWords: numberParam(requestParams, "targetWords"),
            tone: stringParam(requestParams, "tone"),
            tonePreset: tonePresetParam(requestParams, "tonePreset"),
            profanityLevel: profanityLevelParam(requestParams, "profanityLevel"),
            liveModel: false,
          },
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.createDraft",
    async ({ params: requestParams, respond }) => {
      try {
        const topic = stringParam(requestParams, "topic", true);
        const created = await createAndSaveBookPlan({
          config,
          request: {
            topic,
            genre: stringParam(requestParams, "genre"),
            penName: stringParam(requestParams, "penName"),
            targetWords: numberParam(requestParams, "targetWords"),
            tone: stringParam(requestParams, "tone"),
            tonePreset: tonePresetParam(requestParams, "tonePreset"),
            profanityLevel: profanityLevelParam(requestParams, "profanityLevel"),
            liveModel: false,
          },
        });
        const drafted = await draftAndSaveBookPlan({
          config,
          runId: created.runId,
          baseVersion: created.version,
          fetchImpl,
        });
        const result = await stitchAndSaveBookPlan({
          config,
          runId: drafted.runId,
          baseVersion: drafted.version,
        });
        respond(true, {
          ...(await buildSnapshot({ ...snapshotParams, runId: result.plan.runId })),
          manuscriptPath: result.manuscriptPath,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.save",
    async ({ params: requestParams, respond }) => {
      try {
        const plan = await saveBookPlan({
          config,
          plan: bookPlanParam(requestParams),
          baseVersion: numberParam(requestParams, "baseVersion"),
          action: "save",
          summary: "Saved dashboard edits.",
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.suggestSetupField",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await suggestBookSetupTopicWithContext({
            config,
            topic: stringParam(requestParams, "topic") ?? "",
            targetWords: numberParam(requestParams, "targetWords"),
            tonePreset: stringParam(requestParams, "tonePreset") as BookPlanTonePreset | undefined,
            tone: stringParam(requestParams, "tone"),
            profanityLevel: stringParam(requestParams, "profanityLevel") as
              | BookPlanProfanityLevel
              | undefined,
            penName: stringParam(requestParams, "penName"),
            intent: aiHelpIntentParam(requestParams),
            customDirection: stringParam(requestParams, "customDirection"),
            fetchImpl,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.suggestField",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await readBookPlan(config, runId);
        if (!plan) {
          throw new Error(`book plan not found: ${runId}`);
        }
        respond(
          true,
          await suggestBookPlanFieldWithContext({
            config,
            plan,
            target: aiHelpTargetParam(requestParams),
            intent: aiHelpIntentParam(requestParams),
            chapterId: stringParam(requestParams, "chapterId"),
            paragraphId: stringParam(requestParams, "paragraphId"),
            customDirection: stringParam(requestParams, "customDirection"),
            fetchImpl,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.generateIdeaSetup",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await generateAndSaveIdeaSetup({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          targets: optionalStringArrayParam(requestParams, "targets") as
            | BookWriterIdeaSetupTarget[]
            | undefined,
          fetchImpl,
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.generateChapterSetup",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await generateAndSaveChapterSetup({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          targets: optionalStringArrayParam(requestParams, "targets") as
            | BookWriterChapterSetupTarget[]
            | undefined,
          fetchImpl,
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.fillPlanSection",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await fillAndSaveParagraphPlanFields({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          chapterId: stringParam(requestParams, "chapterId"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.penNames.update",
    async ({ params: requestParams, respond }) => {
      try {
        await updatePenNameProfile(config, {
          name: stringParam(requestParams, "name", true),
          lane: stringParam(requestParams, "lane", true),
          readerPromise: stringParam(requestParams, "readerPromise", true),
        });
        respond(
          true,
          await buildSnapshot({ ...snapshotParams, runId: stringParam(requestParams, "runId") }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.cover.localStatus",
    async ({ respond }) => {
      try {
        respond(true, await readLocalCoverAiStatus(appConfig, fetchImpl));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.cover.generateLocalImage",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await generateAndSaveLocalAiCoverImage({
          config,
          appConfig,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.cover.editLocalImage",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await generateAndSaveLocalAiCoverImage({
          config,
          appConfig,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          instruction: stringParam(requestParams, "instruction", true),
          referenceVariantId: stringParam(requestParams, "variantId"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.cover.generateConcept",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await generateAndSaveBookPlanCoverConcept({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.cover.generate",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await generateAndSaveBookPlanCoverConcept({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.cover.upload",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await uploadBookPlanCover({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          fileName: stringParam(requestParams, "fileName", true),
          mimeType: stringParam(requestParams, "mimeType"),
          dataBase64: stringParam(requestParams, "dataBase64", true),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.cover.approve",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await approveBookPlanCover({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          variantId: stringParam(requestParams, "variantId"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.automation.disable",
    async ({ respond }) => {
      try {
        await disableBookWriterAutomation(config);
        respond(true, await buildSnapshot({ ...snapshotParams }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.delete",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        await deleteBookPlan({ config, runId });
        const selectedRunId = stringParam(requestParams, "selectedRunId");
        respond(
          true,
          await buildSnapshot({
            ...snapshotParams,
            runId: selectedRunId && selectedRunId !== runId ? selectedRunId : undefined,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.deleteMany",
    async ({ params: requestParams, respond }) => {
      try {
        const runIds = stringArrayParam(requestParams, "runIds", true);
        await deleteBookPlans({ config, runIds });
        const selectedRunId = stringParam(requestParams, "selectedRunId");
        respond(
          true,
          await buildSnapshot({
            ...snapshotParams,
            runId: selectedRunId && !runIds.includes(selectedRunId) ? selectedRunId : undefined,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.archive",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        await archiveBookPlan({ config, runId });
        const selectedRunId = stringParam(requestParams, "selectedRunId");
        respond(
          true,
          await buildSnapshot({
            ...snapshotParams,
            runId: selectedRunId && selectedRunId !== runId ? selectedRunId : undefined,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.copy",
    async ({ params: requestParams, respond }) => {
      try {
        const plan = await copyBookPlan({
          config,
          runId: stringParam(requestParams, "runId", true),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.unarchive",
    async ({ params: requestParams, respond }) => {
      try {
        const plan = await restoreArchivedBookPlan({
          config,
          archivedId: stringParam(requestParams, "archivedId", true),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.deleteArchived",
    async ({ params: requestParams, respond }) => {
      try {
        await deleteArchivedBookPlan({
          config,
          archivedId: stringParam(requestParams, "archivedId", true),
        });
        respond(true, await buildSnapshot({ ...snapshotParams }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.restore",
    async ({ params: requestParams, respond }) => {
      try {
        const plan = await restoreDeletedBookPlan({
          config,
          deletedId: stringParam(requestParams, "deletedId", true),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.deleteDeleted",
    async ({ params: requestParams, respond }) => {
      try {
        await deleteDeletedBookPlan({
          config,
          deletedId: stringParam(requestParams, "deletedId", true),
        });
        respond(true, await buildSnapshot({ ...snapshotParams }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.emptyDeleted",
    async ({ respond }) => {
      try {
        await emptyDeletedBookPlans({ config });
        respond(true, await buildSnapshot({ ...snapshotParams }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.finish",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        await finishBookPlan({
          config,
          runId,
          proof: objectParam<PublishedBookProof>(requestParams, "proof"),
          metrics: objectParam<PublishedBookMetrics>(requestParams, "metrics"),
        });
        const selectedRunId = stringParam(requestParams, "selectedRunId");
        respond(
          true,
          await buildSnapshot({
            ...snapshotParams,
            runId: selectedRunId && selectedRunId !== runId ? selectedRunId : undefined,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.markPublished",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        await finishBookPlan({
          config,
          runId,
          proof: objectParam<PublishedBookProof>(requestParams, "proof"),
          metrics: objectParam<PublishedBookMetrics>(requestParams, "metrics"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: APPROVAL_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.published.updateMetrics",
    async ({ params: requestParams, respond }) => {
      try {
        await updatePublishedBookMetrics({
          config,
          finishedId: stringParam(requestParams, "finishedId", true),
          metrics: objectParam<PublishedBookMetrics>(requestParams, "metrics") ?? {},
        });
        respond(true, await buildSnapshot({ ...snapshotParams }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.published.recommendNext",
    async ({ respond }) => {
      try {
        const finishedBooks = await listFinishedBookPlanProjects(config);
        respond(true, recommendNextBookFromPublishedBooks(finishedBooks));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.unfinish",
    async ({ params: requestParams, respond }) => {
      try {
        const plan = await restoreFinishedBookPlan({
          config,
          finishedId: stringParam(requestParams, "finishedId", true),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.draft",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await draftAndSaveBookPlan({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          fetchImpl,
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.draftParagraph",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await draftAndSaveBookPlanParagraph({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          paragraphId: stringParam(requestParams, "paragraphId", true),
          replaceExisting: booleanParam(requestParams, "replaceExisting"),
          fetchImpl,
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.propagateStoryChange",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await propagateAndSaveStoryImpact({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.rebalance",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await rebalanceAndSaveBookPlan({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          targetWords: numberParam(requestParams, "targetWords") ?? 12000,
          fetchImpl,
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.stitch",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const result = await stitchAndSaveBookPlan({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
        });
        respond(true, {
          ...(await buildSnapshot({ ...snapshotParams, runId: result.plan.runId })),
          manuscriptPath: result.manuscriptPath,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.package",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        await packagePlan({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.fix",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        await fixPlan({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.publish.prepare",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const coverStrategy = normalizeKdpCoverStrategy(
          stringParam(requestParams, "coverStrategy"),
        );
        const plan = await readBookPlan(config, runId);
        if (plan && coverStrategy !== "kdp-cover-creator" && plan.cover.status !== "approved") {
          throw new Error(
            "approve a cover or choose KDP Cover Creator before preparing publishing.",
          );
        }
        const dryRun = await prepareKdpDryRun({
          outputDir: config.outputDir,
          runId,
          allowRevise: false,
          coverStrategy,
        });
        if (plan) {
          await saveBookPlan({
            config,
            baseVersion: plan.version,
            plan: {
              ...plan,
              status: dryRun.status === "blocked" ? plan.status : "publish-ready",
              publishing: {
                ...plan.publishing,
                status: dryRun.status === "ready" ? "dry-run-ready" : "approval-required",
              },
              artifactLinks: {
                ...plan.artifactLinks,
                kdpDryRunReport: path.join(
                  resolveRunPaths(config.outputDir, runId).runDir,
                  "kdp-dry-run-report.json",
                ),
                kdpUploadManifest: dryRun.uploadManifestPath,
                kdpBrowserActions: dryRun.browserActionsPath,
              },
            },
            action: "publish-prepare",
            summary: "Prepared browser-assisted KDP dry-run with final submit blocked.",
          });
        }
        respond(true, await buildSnapshot({ ...snapshotParams, runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: APPROVAL_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.quickRead",
    async ({ params: requestParams, respond }) => {
      try {
        const sourceRunId = stringParam(requestParams, "sourceRunId", true);
        const plan = await createQuickReadAndSave({ config, sourceRunId });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.reorderChapter",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await reorderChapter({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          chapterId: stringParam(requestParams, "chapterId", true),
          direction: directionParam(requestParams),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "bookWriter.plan.reorderParagraph",
    async ({ params: requestParams, respond }) => {
      try {
        const runId = stringParam(requestParams, "runId", true);
        const plan = await reorderParagraph({
          config,
          runId,
          baseVersion: numberParam(requestParams, "baseVersion"),
          chapterId: stringParam(requestParams, "chapterId", true),
          paragraphId: stringParam(requestParams, "paragraphId", true),
          direction: directionParam(requestParams),
        });
        respond(true, await buildSnapshot({ ...snapshotParams, runId: plan.runId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}
