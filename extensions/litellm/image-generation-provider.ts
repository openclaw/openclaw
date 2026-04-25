import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ImageGenerationProvider,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { LITELLM_BASE_URL } from "./onboard.js";

const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_LITELLM_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_LITELLM_IMAGE_TIMEOUT_MS = 180_000;
const LITELLM_SUPPORTED_SIZES = [
  "256x256",
  "512x512",
  "1024x1024",
  "1024x1536",
  "1024x1792",
  "1536x1024",
  "1792x1024",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const LITELLM_MAX_INPUT_IMAGES = 5;

type LitellmProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function resolveLitellmProviderConfig(
  cfg: OpenClawConfig | undefined,
): LitellmProviderConfig | undefined {
  return cfg?.models?.providers?.litellm;
}

// Models routed through LiteLLM's chat-completions multimodal path rather than
// the OpenAI-style /images/edits endpoint. These models (Gemini multimodal,
// Anthropic Claude image generation, etc.) live behind chat APIs upstream;
// LiteLLM only exposes them via /v1/chat/completions. Forcing them through
// /v1/images/edits routes to a Vertex/ADC backend that most proxy deployments
// do not configure, surfacing as "default credentials were not found" 500s.
const CHAT_NATIVE_IMAGE_MODEL_PATTERNS: RegExp[] = [/^gemini-/i, /^claude-/i];

function isChatNativeImageModel(model: string): boolean {
  return CHAT_NATIVE_IMAGE_MODEL_PATTERNS.some((p) => p.test(model));
}

function resolveConfiguredLitellmBaseUrl(cfg: OpenClawConfig | undefined): string {
  return normalizeOptionalString(resolveLitellmProviderConfig(cfg)?.baseUrl) ?? LITELLM_BASE_URL;
}

// LiteLLM's default proxy is loopback. Auto-enable private-network access only
// for loopback-style hosts; LAN/custom private endpoints should use the
// explicit models.providers.litellm.request.allowPrivateNetwork opt-in.
function isAutoAllowedLitellmHostname(hostname: string): boolean {
  if (!hostname) {
    return false;
  }
  // Strip IPv6 brackets if any: "[::1]" -> "::1".
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const lowered = host.toLowerCase();
  if (
    lowered === "localhost" ||
    lowered === "host.docker.internal" ||
    lowered.endsWith(".localhost")
  ) {
    return true;
  }
  if (lowered === "127.0.0.1" || lowered.startsWith("127.")) {
    return true;
  }
  if (lowered === "::1" || lowered === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return false;
}

function shouldAutoAllowPrivateLitellmEndpoint(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isAutoAllowedLitellmHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function inferLitellmImageFileName(params: {
  fileName?: string;
  mimeType?: string;
  index: number;
}): string {
  const fileName = params.fileName?.trim();
  if (fileName) {
    return fileName.split(/[\\/]/).pop() ?? fileName;
  }
  const mimeType = params.mimeType?.trim().toLowerCase() || DEFAULT_OUTPUT_MIME;
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.replace(/^image\//, "") || "png";
  return `image-${params.index + 1}.${ext}`;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

type LitellmImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

type LitellmChatImagePart = {
  type?: string;
  image_url?: { url?: string } | string;
};

type LitellmChatStandaloneImage = {
  // Some LiteLLM routes (notably Gemini multimodal via Vertex/AI Studio) wrap
  // each image as a chat-content-style part: `{type: "image_url", image_url:
  // {url: "data:image/png;base64,..."}}`. Other routes ship a flat shape with
  // `b64_json` or a top-level `url`. Support both.
  type?: string;
  image_url?: { url?: string } | string;
  url?: string;
  b64_json?: string;
  data?: string;
  mime_type?: string;
  mimeType?: string;
};

type LitellmChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<LitellmChatImagePart>;
      images?: Array<LitellmChatStandaloneImage | string>;
    };
  }>;
};

type ParsedImage = ImageGenerationResult["images"][number];

const DATA_URL_RE = /data:([^;,]+)(?:;base64)?,([A-Za-z0-9+/=_-]+)/g;

function pushDataUrl(into: ParsedImage[], url: string): void {
  // Single-shot match (anchored at start) for known-good URLs from typed
  // image_url fields. Falls back to a scan if the typed shape ships a longer
  // string with prefix/suffix noise.
  const single = /^data:([^;,]+)(?:;base64)?,([A-Za-z0-9+/=_-]+)$/.exec(url);
  if (single) {
    const [, mime, b64] = single;
    into.push({
      buffer: Buffer.from(b64, "base64"),
      mimeType: mime || DEFAULT_OUTPUT_MIME,
      fileName: `image-${into.length + 1}.${mime === "image/jpeg" ? "jpg" : "png"}`,
    });
    return;
  }
  DATA_URL_RE.lastIndex = 0;
  for (const m of url.matchAll(DATA_URL_RE)) {
    const [, mime, b64] = m;
    into.push({
      buffer: Buffer.from(b64, "base64"),
      mimeType: mime || DEFAULT_OUTPUT_MIME,
      fileName: `image-${into.length + 1}.${mime === "image/jpeg" ? "jpg" : "png"}`,
    });
  }
}

function parseChatCompletionImages(data: LitellmChatCompletionResponse): ParsedImage[] {
  const images: ParsedImage[] = [];
  for (const choice of data.choices ?? []) {
    const message = choice.message;
    if (!message) {
      continue;
    }

    // Prefer the typed `images` array if the proxy ships one (some LiteLLM
    // routes return generated images out-of-band rather than embedding them
    // in `content`).
    for (const standalone of message.images ?? []) {
      if (typeof standalone === "string") {
        if (standalone.startsWith("data:")) {
          pushDataUrl(images, standalone);
        } else {
          // Assume bare base64 with default mime.
          images.push({
            buffer: Buffer.from(standalone, "base64"),
            mimeType: DEFAULT_OUTPUT_MIME,
            fileName: `image-${images.length + 1}.png`,
          });
        }
        continue;
      }
      // Nested chat-content-style shape (Gemini via LiteLLM):
      //   {type: "image_url", image_url: {url: "data:image/png;base64,..."}}
      const nestedImageUrl = standalone.image_url;
      const nestedUrl = typeof nestedImageUrl === "string" ? nestedImageUrl : nestedImageUrl?.url;
      const flatUrl = standalone.url;
      const url = nestedUrl ?? flatUrl;
      const b64 = standalone.b64_json ?? standalone.data;
      const mime = standalone.mime_type ?? standalone.mimeType ?? DEFAULT_OUTPUT_MIME;
      if (b64) {
        images.push({
          buffer: Buffer.from(b64, "base64"),
          mimeType: mime,
          fileName: `image-${images.length + 1}.${mime === "image/jpeg" ? "jpg" : "png"}`,
        });
      } else if (url) {
        if (url.startsWith("data:")) {
          pushDataUrl(images, url);
        }
        // External http(s) URLs intentionally skipped: caller has no SSRF
        // policy here, and chat-completion responses for image gen normally
        // ship inline data URLs anyway.
      }
    }

    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const imageUrl = part.image_url;
        const url = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
        if (url && url.startsWith("data:")) {
          pushDataUrl(images, url);
        }
      }
    } else if (typeof content === "string" && content.includes("data:")) {
      pushDataUrl(images, content);
    }
  }
  return images;
}

function buildChatCompletionMessages(params: {
  prompt: string;
  inputImages: ImageGenerationSourceImage[];
}): Array<Record<string, unknown>> {
  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: params.prompt }];
  for (const image of params.inputImages) {
    const mime = image.mimeType?.trim() || DEFAULT_OUTPUT_MIME;
    userContent.push({
      type: "image_url",
      image_url: { url: toDataUrl(image.buffer, mime) },
    });
  }
  return [{ role: "user", content: userContent }];
}

export function buildLitellmImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "litellm",
    label: "LiteLLM",
    defaultModel: DEFAULT_LITELLM_IMAGE_MODEL,
    models: [DEFAULT_LITELLM_IMAGE_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "litellm",
        agentDir,
      }),
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
        maxInputImages: LITELLM_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...LITELLM_SUPPORTED_SIZES],
      },
    },
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const auth = await resolveApiKeyForProvider({
        provider: "litellm",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("LiteLLM API key missing");
      }
      const providerConfig = resolveLitellmProviderConfig(req.cfg);
      const resolvedBaseUrl = resolveConfiguredLitellmBaseUrl(req.cfg);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolvedBaseUrl,
          defaultBaseUrl: LITELLM_BASE_URL,
          allowPrivateNetwork: shouldAutoAllowPrivateLitellmEndpoint(resolvedBaseUrl)
            ? true
            : undefined,
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "litellm",
          capability: "image",
          transport: "http",
        });

      const model = req.model || DEFAULT_LITELLM_IMAGE_MODEL;
      const count = req.count ?? 1;
      const size = req.size ?? DEFAULT_SIZE;
      const timeoutMs = req.timeoutMs ?? DEFAULT_LITELLM_IMAGE_TIMEOUT_MS;

      // Chat-native multimodal models (Gemini, Claude, etc.) live on the chat
      // completions endpoint upstream. Routing them through /images/edits
      // makes the proxy dispatch to a Vertex backend that needs ADC and fails
      // with HTTP 500 on most deployments.
      if (isChatNativeImageModel(model)) {
        const jsonHeaders = new Headers(headers);
        jsonHeaders.set("Content-Type", "application/json");
        const { response, release } = await postJsonRequest({
          url: `${baseUrl}/chat/completions`,
          headers: jsonHeaders,
          body: {
            model,
            messages: buildChatCompletionMessages({ prompt: req.prompt, inputImages }),
            n: count,
          },
          timeoutMs,
          fetchFn: fetch,
          allowPrivateNetwork,
          dispatcherPolicy,
        });
        try {
          await assertOkOrThrowHttpError(
            response,
            isEdit
              ? "LiteLLM chat-completions image edit failed"
              : "LiteLLM chat-completions image generation failed",
          );
          const data = (await response.json()) as LitellmChatCompletionResponse;
          const images = parseChatCompletionImages(data);
          if (images.length === 0) {
            throw new Error("LiteLLM chat-completions response did not contain image data");
          }
          return { images, model };
        } finally {
          await release();
        }
      }

      // OpenAI-compatible image API path (gpt-image-*, dall-e-*, etc.).
      const endpoint = isEdit ? "images/edits" : "images/generations";
      const url = `${baseUrl}/${endpoint}`;
      const { response, release } = isEdit
        ? await (() => {
            const form = new FormData();
            form.set("model", model);
            form.set("prompt", req.prompt);
            form.set("n", String(count));
            form.set("size", size);
            for (const [index, image] of inputImages.entries()) {
              const mimeType = image.mimeType?.trim() || DEFAULT_OUTPUT_MIME;
              form.append(
                "image[]",
                new Blob([new Uint8Array(image.buffer)], { type: mimeType }),
                inferLitellmImageFileName({
                  fileName: image.fileName,
                  mimeType,
                  index,
                }),
              );
            }
            const multipartHeaders = new Headers(headers);
            multipartHeaders.delete("Content-Type");
            return postMultipartRequest({
              url,
              headers: multipartHeaders,
              body: form,
              timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            });
          })()
        : await (() => {
            const jsonHeaders = new Headers(headers);
            jsonHeaders.set("Content-Type", "application/json");
            return postJsonRequest({
              url,
              headers: jsonHeaders,
              body: {
                model,
                prompt: req.prompt,
                n: count,
                size,
              },
              timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            });
          })();
      try {
        await assertOkOrThrowHttpError(
          response,
          isEdit ? "LiteLLM image edit failed" : "LiteLLM image generation failed",
        );

        const data = (await response.json()) as LitellmImageApiResponse;
        const images = (data.data ?? [])
          .map((entry, index) => {
            if (!entry.b64_json) {
              return null;
            }
            return Object.assign(
              {
                buffer: Buffer.from(entry.b64_json, `base64`),
                mimeType: DEFAULT_OUTPUT_MIME,
                fileName: `image-${index + 1}.png`,
              },
              entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {},
            );
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
