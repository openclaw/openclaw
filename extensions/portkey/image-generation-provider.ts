import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { PORTKEY_BASE_URL } from "./onboard.js";

const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_PORTKEY_IMAGE_MODEL = "gpt-image-2";
const PORTKEY_SUPPORTED_SIZES = [
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
const PORTKEY_MAX_INPUT_IMAGES = 5;

type PortkeyProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function resolvePortkeyProviderConfig(
  cfg: OpenClawConfig | undefined,
): PortkeyProviderConfig | undefined {
  return cfg?.models?.providers?.portkey;
}

function resolveConfiguredPortkeyBaseUrl(cfg: OpenClawConfig | undefined): string {
  return normalizeOptionalString(resolvePortkeyProviderConfig(cfg)?.baseUrl) ?? PORTKEY_BASE_URL;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

type PortkeyImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

export function buildPortkeyImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "portkey",
    label: "Portkey",
    defaultModel: DEFAULT_PORTKEY_IMAGE_MODEL,
    models: [DEFAULT_PORTKEY_IMAGE_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "portkey",
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
        maxInputImages: PORTKEY_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...PORTKEY_SUPPORTED_SIZES],
      },
    },
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const auth = await resolveApiKeyForProvider({
        provider: "portkey",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Portkey API key missing");
      }
      const providerConfig = resolvePortkeyProviderConfig(req.cfg);
      const resolvedBaseUrl = resolveConfiguredPortkeyBaseUrl(req.cfg);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolvedBaseUrl,
          defaultBaseUrl: PORTKEY_BASE_URL,
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
          defaultHeaders: {
            "x-portkey-api-key": auth.apiKey,
          },
          provider: "portkey",
          capability: "image",
          transport: "http",
        });

      const model = req.model || DEFAULT_PORTKEY_IMAGE_MODEL;
      const count = req.count ?? 1;
      const size = req.size ?? DEFAULT_SIZE;

      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");
      const endpoint = isEdit ? "images/edits" : "images/generations";
      const body = isEdit
        ? {
            model,
            prompt: req.prompt,
            n: count,
            size,
            images: inputImages.map((image) => ({
              image_url: toDataUrl(image.buffer, image.mimeType?.trim() || DEFAULT_OUTPUT_MIME),
            })),
          }
        : {
            model,
            prompt: req.prompt,
            n: count,
            size,
          };
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/${endpoint}`,
        headers: jsonHeaders,
        body,
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(
          response,
          isEdit ? "Portkey image edit failed" : "Portkey image generation failed",
        );

        const data = (await response.json()) as PortkeyImageApiResponse;
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
