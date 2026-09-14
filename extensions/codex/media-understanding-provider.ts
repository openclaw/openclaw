/**
 * Codex-backed media understanding provider for bounded image description and
 * structured extraction turns.
 */
import type {
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  MediaUnderstandingProvider,
  StructuredExtractionRequest,
  StructuredExtractionResult,
} from "openclaw/plugin-sdk/media-understanding";
import type { CodexBoundedTurnOptions } from "./src/app-server/bounded-turn.js";
import type { CodexUserInput } from "./src/app-server/protocol.js";

const CODEX_MEDIA_PROVIDER_ID = "codex";
const DEFAULT_CODEX_IMAGE_MODEL = "gpt-6-astra";
const DEFAULT_CODEX_IMAGE_PROMPT = "Describe the image.";

/**
 * Builds the media-understanding provider that delegates image tasks to an
 * isolated Codex app-server session.
 */
export function buildCodexMediaUnderstandingProvider(
  options: CodexBoundedTurnOptions = {},
): MediaUnderstandingProvider {
  return {
    id: CODEX_MEDIA_PROVIDER_ID,
    capabilities: ["image"],
    defaultModels: { image: DEFAULT_CODEX_IMAGE_MODEL },
    describeImage: async (req) =>
      describeCodexImages(
        {
          images: [
            {
              buffer: req.buffer,
              fileName: req.fileName,
              mime: req.mime,
            },
          ],
          provider: req.provider,
          model: req.model,
          prompt: req.prompt,
          maxTokens: req.maxTokens,
          timeoutMs: req.timeoutMs,
          ...(req.signal ? { signal: req.signal } : {}),
          profile: req.profile,
          preferredProfile: req.preferredProfile,
          authStore: req.authStore,
          agentDir: req.agentDir,
          cfg: req.cfg,
        },
        options,
      ),
    describeImages: async (req) => describeCodexImages(req, options),
    extractStructured: async (req) => extractCodexStructured(req, options),
  };
}

async function describeCodexImages(
  req: ImagesDescriptionRequest,
  options: CodexBoundedTurnOptions,
): Promise<ImagesDescriptionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Codex image understanding requires model id.");
  }
  req.signal?.throwIfAborted();
  const { runBoundedCodexAppServerTurn } = await import("./src/app-server/bounded-turn.js");
  req.signal?.throwIfAborted();
  const { text } = await runBoundedCodexAppServerTurn({
    config: req.cfg,
    model: { mode: "required", id: model },
    modelProvider: "openai",
    profile: req.profile,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    agentDir: req.agentDir,
    authProfileStore: req.authStore,
    options,
    taskLabel: "image understanding",
    developerInstructions:
      "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
    input: [
      { type: "text", text: buildCodexImagePrompt(req), text_elements: [] },
      ...req.images.map((image) => ({
        type: "image" as const,
        url: `data:${image.mime ?? "image/png"};base64,${image.buffer.toString("base64")}`,
      })),
    ],
    requiredModalities: ["text", "image"],
    isolation: "configured-transport",
  });
  return { text, model };
}

async function extractCodexStructured(
  req: StructuredExtractionRequest,
  options: CodexBoundedTurnOptions,
): Promise<StructuredExtractionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Codex structured extraction requires model id.");
  }
  const instructions = req.instructions.trim();
  if (!instructions) {
    throw new Error("Codex structured extraction requires instructions.");
  }
  if (req.input.length === 0) {
    throw new Error("Codex structured extraction requires at least one input.");
  }
  if (!req.input.some((entry) => entry.type === "image")) {
    throw new Error("Codex structured extraction requires at least one image input.");
  }
  req.signal?.throwIfAborted();
  const { runBoundedCodexAppServerTurn } = await import("./src/app-server/bounded-turn.js");
  // Deferred like bounded-turn above: the media-understanding barrel loads
  // shared media runtime modules that must stay out of registration imports.
  const { buildStructuredExtractionPrompt, normalizeStructuredExtractionResult } =
    await import("openclaw/plugin-sdk/media-understanding");
  req.signal?.throwIfAborted();
  const { text } = await runBoundedCodexAppServerTurn({
    config: req.cfg,
    model: { mode: "required", id: model },
    modelProvider: "openai",
    profile: req.profile,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    agentDir: req.agentDir,
    authProfileStore: req.authStore,
    options,
    taskLabel: "structured extraction",
    developerInstructions:
      "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not call tools, edit files, ask follow-up questions, or include secrets.",
    input: buildCodexStructuredInput(req, buildStructuredExtractionPrompt(req)),
    requiredModalities: ["text", "image"],
    isolation: "configured-transport",
  });
  return await normalizeStructuredExtractionResult({
    text,
    model,
    provider: req.provider,
    request: req,
    errorLabel: "Codex structured extraction",
    validationCacheKey: "codex.media-understanding.extractStructured",
  });
}

function buildCodexImagePrompt(req: ImagesDescriptionRequest): string {
  const prompt = req.prompt?.trim() || DEFAULT_CODEX_IMAGE_PROMPT;
  if (req.images.length <= 1) {
    return prompt;
  }
  return `${prompt}\n\nAnalyze all ${req.images.length} images together.`;
}

function buildCodexStructuredInput(
  req: StructuredExtractionRequest,
  prompt: string,
): CodexUserInput[] {
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...req.input.map((entry) => {
      if (entry.type === "text") {
        return { type: "text" as const, text: entry.text, text_elements: [] };
      }
      return {
        type: "image" as const,
        url: `data:${entry.mime ?? "image/png"};base64,${entry.buffer.toString("base64")}`,
      };
    }),
  ];
}
