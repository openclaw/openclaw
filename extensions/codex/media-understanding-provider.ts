import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  MediaUnderstandingProvider,
  StructuredExtractionRequest,
  StructuredExtractionResult,
} from "openclaw/plugin-sdk/media-understanding";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexBoundedTurnOptions } from "./src/app-server/bounded-turn.js";
import type { CodexUserInput } from "./src/app-server/protocol.js";

const loadBoundedTurn = createLazyRuntimeModule(() => import("./src/app-server/bounded-turn.js"));

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
    describeImage: async ({ buffer, fileName, mime, ...req }) =>
      runCodexMediaTask(
        {
          kind: "image",
          request: { ...req, images: [{ buffer, fileName, mime }] },
        },
        options,
      ),
    describeImages: async (req) => runCodexMediaTask({ kind: "image", request: req }, options),
    extractStructured: async (req) =>
      runCodexMediaTask({ kind: "structured", request: req }, options),
  };
}

async function runCodexMediaTask(
  task:
    | { kind: "image"; request: ImagesDescriptionRequest }
    | { kind: "structured"; request: StructuredExtractionRequest },
  options: CodexBoundedTurnOptions,
): Promise<ImagesDescriptionResult | StructuredExtractionResult> {
  const { kind, request: req } = task;
  const taskLabel = kind === "image" ? "image understanding" : "structured extraction";
  const model = req.model.trim();
  if (!model) {
    throw new Error(`Codex ${taskLabel} requires model id.`);
  }
  if (kind === "structured") {
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
  }
  req.signal?.throwIfAborted();
  const { runBoundedCodexAppServerTurn } = await loadBoundedTurn();
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
    taskLabel,
    developerInstructions:
      kind === "image"
        ? "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions."
        : "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not call tools, edit files, ask follow-up questions, or include secrets.",
    input:
      kind === "image"
        ? [
            { type: "text", text: buildCodexImagePrompt(req), text_elements: [] },
            ...req.images.map((image) => ({
              type: "image" as const,
              url: `data:${image.mime ?? "image/png"};base64,${image.buffer.toString("base64")}`,
            })),
          ]
        : buildCodexStructuredInput(req),
    requiredModalities: ["text", "image"],
    isolation: "configured-transport",
  });
  if (kind === "image") {
    return { text, model };
  }
  const result: StructuredExtractionResult = {
    text,
    model,
    provider: req.provider,
    contentType: req.jsonMode === false ? "text" : "json",
  };
  if (req.jsonMode !== false) {
    try {
      result.parsed = JSON.parse(text);
    } catch {
      throw new Error("Codex structured extraction returned invalid JSON.");
    }
    if (isRecord(req.jsonSchema)) {
      const validation = validateJsonSchemaValue({
        schema: req.jsonSchema,
        cacheKey: "codex.media-understanding.extractStructured",
        value: result.parsed,
        cache: false,
      });
      if (!validation.ok) {
        const message = validation.errors.map((error) => error.text).join("; ") || "invalid";
        throw new Error(`Codex structured extraction JSON did not match schema: ${message}`);
      }
      result.parsed = validation.value;
    }
  }
  return result;
}

function buildCodexImagePrompt(req: ImagesDescriptionRequest): string {
  const prompt = req.prompt?.trim() || DEFAULT_CODEX_IMAGE_PROMPT;
  if (req.images.length <= 1) {
    return prompt;
  }
  return `${prompt}\n\nAnalyze all ${req.images.length} images together.`;
}

function buildCodexStructuredInput(req: StructuredExtractionRequest): CodexUserInput[] {
  const prompt = [
    req.instructions.trim(),
    req.schemaName ? `Schema name: ${req.schemaName}` : undefined,
    req.jsonSchema ? `JSON schema:\n${JSON.stringify(req.jsonSchema)}` : undefined,
    req.jsonMode === false
      ? "Return the extraction as concise text."
      : "Return valid JSON only. Do not wrap the JSON in Markdown fences.",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
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
