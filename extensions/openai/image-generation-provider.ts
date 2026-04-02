import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  postTranscriptionRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_INPUT_IMAGE_MIME = "image/png";
const OPENAI_SUPPORTED_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const OPENAI_MAX_INPUT_IMAGES = 5;

type OpenAIImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

function resolveOpenAIBaseUrl(cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"]): string {
  const direct = cfg?.models?.providers?.openai?.baseUrl?.trim();
  return direct || DEFAULT_OPENAI_IMAGE_BASE_URL;
}

function inferFileExtensionFromMimeType(mimeType: string): string {
  if (mimeType.includes("jpeg")) {
    return "jpg";
  }
  if (mimeType.includes("webp")) {
    return "webp";
  }
  return "png";
}

function toBlobBytes(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

export function buildOpenAIImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: DEFAULT_OPENAI_IMAGE_MODEL,
    models: [DEFAULT_OPENAI_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: OPENAI_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...OPENAI_SUPPORTED_SIZES],
      },
    },
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const auth = await resolveApiKeyForProvider({
        provider: "openai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveOpenAIBaseUrl(req.cfg),
          defaultBaseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "openai",
          capability: "image",
          transport: "http",
        });

      const model = req.model || DEFAULT_OPENAI_IMAGE_MODEL;
      const count = req.count ?? 1;
      const size = req.size ?? DEFAULT_SIZE;
      const requestResult = isEdit
        ? await (() => {
            const form = new FormData();
            form.set("model", model);
            form.set("prompt", req.prompt);
            form.set("n", String(count));
            form.set("size", size);
            inputImages.forEach((image, index) => {
              const mimeType = image.mimeType?.trim() || DEFAULT_INPUT_IMAGE_MIME;
              const extension = inferFileExtensionFromMimeType(mimeType);
              const fileName = image.fileName?.trim() || `image-${index + 1}.${extension}`;
              form.append(
                "image",
                new Blob([toBlobBytes(image.buffer)], { type: mimeType }),
                fileName,
              );
            });
            const multipartHeaders = new Headers(headers);
            multipartHeaders.delete("Content-Type");
            return postTranscriptionRequest({
              url: `${baseUrl}/images/edits`,
              headers: multipartHeaders,
              body: form,
              timeoutMs: req.timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            });
          })()
        : await (() => {
            const jsonHeaders = new Headers(headers);
            jsonHeaders.set("Content-Type", "application/json");
            return postJsonRequest({
              url: `${baseUrl}/images/generations`,
              headers: jsonHeaders,
              body: {
                model,
                prompt: req.prompt,
                n: count,
                size,
              },
              timeoutMs: req.timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            });
          })();
      const { response, release } = requestResult;
      try {
        await assertOkOrThrowHttpError(
          response,
          isEdit ? "OpenAI image edit failed" : "OpenAI image generation failed",
        );

        const data = (await response.json()) as OpenAIImageApiResponse;
        const images = (data.data ?? [])
          .map((entry, index) => {
            if (!entry.b64_json) {
              return null;
            }
            return {
              buffer: Buffer.from(entry.b64_json, "base64"),
              mimeType: DEFAULT_OUTPUT_MIME,
              fileName: `image-${index + 1}.png`,
              ...(entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {}),
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
  };
}
