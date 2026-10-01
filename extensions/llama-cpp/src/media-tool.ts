import path from "node:path";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  asPositiveSafeInteger,
  isRecord,
  normalizeOptionalString,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { LLAMA_CPP_PROVIDER_ID } from "./defaults.js";
import {
  LLAMA_CPP_MEDIA_MAX_BYTES,
  LLAMA_CPP_MEDIA_MAX_CHARS,
  LLAMA_CPP_MEDIA_MAX_TOKENS,
  LLAMA_CPP_MEDIA_TIMEOUT_MS,
  isManagedLlamaCppMediaProvider,
  resolveLlamaCppMediaModels,
} from "./media-config.js";

/** Maps explicit task intent onto the same provider hook used by normal image understanding. */
export function registerLlamaCppMediaTool(
  api: OpenClawPluginApi,
  provider: MediaUnderstandingProvider,
): void {
  api.registerTool(
    (ctx) => {
      // Plugin tool context has no sandbox filesystem bridge; host reads cannot stand in for it.
      if (ctx.sandboxed || !provider.describeImage) {
        return null;
      }
      const describeImage = provider.describeImage;
      const getConfig = () =>
        ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config ?? api.config;
      const configured = getConfig().models?.providers?.[LLAMA_CPP_PROVIDER_ID];
      if (!isManagedLlamaCppMediaProvider(configured) || !resolveLlamaCppMediaModels(configured)) {
        return null;
      }
      return {
        name: "local_image",
        label: "Local Image",
        description:
          "Inspect a local image with installed local models. Choose task ocr to transcribe visible text, or vision for photos, charts, diagrams, and spatial questions (default). No cloud fallback or model downloads. The original image remains available.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              minLength: 1,
              description: "Local image path or media:// reference.",
            },
            task: { type: "string", enum: ["ocr", "vision"], default: "vision" },
            prompt: { type: "string", maxLength: 8192 },
          },
          required: ["path"],
          additionalProperties: false,
        },
        async execute(_toolCallId, args, signal) {
          signal?.throwIfAborted();
          if (!isRecord(args)) {
            throw new Error(
              "Local image input must contain a path and optional ocr or vision task.",
            );
          }
          const task = args.task === undefined ? "vision" : args.task;
          if (task !== "ocr" && task !== "vision") {
            throw new Error("Local image task must be ocr or vision.");
          }
          const input = normalizeOptionalString(args.path);
          if (!input) {
            throw new Error("Local image path is required.");
          }
          if (
            /^[a-z][a-z0-9+.-]*:/iu.test(input) &&
            !input.startsWith("media://") &&
            !/^[a-z]:[\\/]/iu.test(input)
          ) {
            throw new Error(
              "Local image requires a local path or media:// reference; URLs are not accepted.",
            );
          }
          if (
            args.prompt !== undefined &&
            (typeof args.prompt !== "string" || args.prompt.length > 8192)
          ) {
            throw new Error("Local image prompt must be a string of at most 8192 characters.");
          }
          const cfg = getConfig();
          const configuredProvider = cfg.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
          const models = resolveLlamaCppMediaModels(configuredProvider);
          if (!isManagedLlamaCppMediaProvider(configuredProvider) || !models || !ctx.agentDir) {
            throw new Error(
              "Run managed local media setup for this agent without an explicit llama.cpp request proxy before using local_image. When using an environment proxy, add the server address to NO_PROXY.",
            );
          }
          const model = configuredProvider?.models.find((entry) => entry.id === models[task]);
          if (!model?.input.includes("image")) {
            throw new Error(
              `The configured local ${task} model is unavailable. Run managed local media setup again.`,
            );
          }
          if (model.baseUrl !== undefined && model.baseUrl !== configuredProvider?.baseUrl) {
            throw new Error(
              "The local image model endpoint must match the managed llama.cpp provider. Run managed local media setup again.",
            );
          }
          const workspace = ctx.fsPolicy?.root ?? ctx.workspaceDir;
          const localRoots = ctx.fsPolicy?.workspaceOnly
            ? workspace
              ? [path.resolve(workspace)]
              : []
            : (await import("openclaw/plugin-sdk/media-local-roots")).getAgentScopedMediaLocalRoots(
                cfg,
                ctx.agentId,
                workspace,
              );
          const imageConfig = cfg.tools?.media?.image;
          const maxBytes = Math.min(
            asPositiveSafeInteger(imageConfig?.maxBytes) ?? LLAMA_CPP_MEDIA_MAX_BYTES,
            LLAMA_CPP_MEDIA_MAX_BYTES,
          );
          const maxChars = Math.min(
            asPositiveSafeInteger(imageConfig?.maxChars) ?? LLAMA_CPP_MEDIA_MAX_CHARS,
            LLAMA_CPP_MEDIA_MAX_CHARS,
          );
          const timeoutMs = Math.min(
            imageConfig?.timeoutSeconds === undefined
              ? LLAMA_CPP_MEDIA_TIMEOUT_MS
              : (asPositiveSafeInteger(imageConfig.timeoutSeconds) ?? 600) * 1000,
            2_147_483_647,
          );
          const source =
            input.startsWith("media://") || path.isAbsolute(input)
              ? input
              : path.resolve(workspace ?? process.cwd(), input);
          signal?.throwIfAborted();
          const image = await api.runtime.media.loadWebMedia(source, {
            maxBytes,
            localRoots,
            ...(signal ? { requestInit: { signal } } : {}),
          });
          signal?.throwIfAborted();
          if (image.kind !== "image") {
            throw new Error("Local image input must be an image.");
          }
          const result = await describeImage({
            buffer: image.buffer,
            fileName: image.fileName ?? path.basename(source),
            mime: image.contentType,
            provider: LLAMA_CPP_PROVIDER_ID,
            model: model.id,
            prompt:
              normalizeOptionalString(args.prompt) ??
              (task === "ocr"
                ? "Transcribe all visible text exactly. Return only the text."
                : "Describe the image."),
            maxTokens: Math.min(
              asPositiveSafeInteger(model.maxTokens) ?? LLAMA_CPP_MEDIA_MAX_TOKENS,
              LLAMA_CPP_MEDIA_MAX_TOKENS,
            ),
            timeoutMs,
            signal,
            cfg,
            agentId: ctx.agentId,
            agentDir: ctx.agentDir,
            workspaceDir: ctx.workspaceDir,
          });
          signal?.throwIfAborted();
          if (!result.text.trim()) {
            throw new Error(
              "The local image model returned no text. Run managed local media setup again.",
            );
          }
          return textResult(truncateUtf16Safe(result.text, maxChars), {
            task,
            provider: LLAMA_CPP_PROVIDER_ID,
            model: result.model ?? model.id,
            path: input,
          });
        },
      };
    },
    { name: "local_image" },
  );
}
