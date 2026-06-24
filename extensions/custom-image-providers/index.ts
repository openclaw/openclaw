import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type ProviderModelConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string] extends infer T
  ? T extends { models?: infer M }
    ? M extends Array<infer Item>
      ? Item
      : never
    : never
  : never;

type PluginProviderConfig = {
  label?: string;
  defaultModel?: string;
  models?: string[];
  enableEdits?: boolean;
  maxInputImages?: number;
  sizes?: string[];
  apiKey?: string;
  headers?: Record<string, string>;
};

const PLUGIN_ID = "custom-image-providers";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_SIZES = [
  "256x256",
  "512x512",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1792x1024",
  "1024x1792",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeId(value: unknown): string | undefined {
  const trimmed = normalizeString(value);
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function resolveStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}

function readOpenClawConfig(): OpenClawConfig {
  const file = path.join(resolveStateDir(), "openclaw.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as OpenClawConfig;
  } catch {
    return {} as OpenClawConfig;
  }
}

function readPluginConfig(): {
  providerIds?: string[];
  providers?: Record<string, PluginProviderConfig>;
} {
  const cfg = readOpenClawConfig();
  return (cfg?.plugins?.entries?.[PLUGIN_ID]?.config ?? {}) as {
    providerIds?: string[];
    providers?: Record<string, PluginProviderConfig>;
  };
}

function resolvePlaceholder(value: unknown): string | undefined {
  const trimmed = normalizeString(value);
  if (!trimmed) return undefined;
  const match = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (!match) return trimmed;
  return normalizeString(process.env[match[1]]);
}

function providerLabel(providerId: string, override?: PluginProviderConfig): string {
  const explicit = normalizeString(override?.label);
  if (explicit) return explicit;
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isImageModel(model: ProviderModelConfig): boolean {
  if (!model || typeof model !== "object") return false;
  const id = (normalizeString((model as { id?: string }).id) || "").toLowerCase();
  const name = (normalizeString((model as { name?: string }).name) || "").toLowerCase();
  const haystack = `${id} ${name}`;
  const explicitImagePatterns = [
    /(^|\/)gpt-image-/,
    /(^|\/)dall-e/,
    /(^|\/)flux(?:$|[/-])/, 
    /(^|\/)recraft(?:$|[/-])/, 
    /stable-diffusion/,
    /(^|\/)sdxl(?:$|[/-])/, 
    /nano-banana/,
    /image-preview/,
    /flash-image-preview/,
    /pro-image-preview/,
    /image-to-image/,
  ];
  return explicitImagePatterns.some((pattern) => pattern.test(haystack));
}

function detectImageModels(
  providerConfig: { models?: ProviderModelConfig[] } | undefined,
  override?: PluginProviderConfig,
): string[] {
  const configured = Array.isArray(override?.models)
    ? override.models.map(normalizeString).filter((value): value is string => Boolean(value))
    : [];
  if (configured.length > 0) return configured;
  const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  return models
    .filter(isImageModel)
    .map((model) => normalizeString((model as { id?: string }).id))
    .filter((value): value is string => Boolean(value));
}

function normalizeHeaders(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source || typeof source !== "object") return out;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const name = normalizeString(key);
    const resolved = resolvePlaceholder(value);
    if (name && resolved) out[name] = resolved;
  }
  return out;
}

function mergeHeaders(
  providerConfig: Record<string, unknown> | undefined,
  pluginProviderConfig?: PluginProviderConfig,
): Record<string, string> {
  return {
    ...normalizeHeaders(providerConfig?.headers),
    ...normalizeHeaders((providerConfig?.request as Record<string, unknown> | undefined)?.headers),
    ...normalizeHeaders(pluginProviderConfig?.headers),
  };
}

function parseDataUrl(value: string): { mimeType: string; buffer: Buffer } | null {
  const match = value.match(/^data:(image\/[^;,]+)(?:;[^,]*)?;base64,(.+)$/i);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
}

async function fetchRemoteImage(
  url: string,
  headers: Headers,
): Promise<{ mimeType: string; buffer: Buffer }> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);
  return {
    mimeType: response.headers.get("content-type") || "image/png",
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

async function parseImageEntry(entry: Record<string, unknown>, index: number, headers: Headers) {
  const revisedPrompt = normalizeString(entry.revised_prompt);
  const b64 = normalizeString(entry.b64_json);
  if (b64) {
    return {
      buffer: Buffer.from(b64, "base64"),
      mimeType: normalizeString(entry.mime_type) || "image/png",
      fileName: `image-${index + 1}.png`,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }
  const imageUrlObject = entry.image_url as { url?: string } | undefined;
  const url =
    normalizeString(entry.url) ||
    normalizeString(imageUrlObject?.url) ||
    normalizeString(entry.image_url);
  if (!url) return null;
  const dataUrl = parseDataUrl(url);
  if (dataUrl) {
    return {
      buffer: dataUrl.buffer,
      mimeType: dataUrl.mimeType,
      fileName: `image-${index + 1}.png`,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }
  if (/^https?:\/\//i.test(url)) {
    const remote = await fetchRemoteImage(url, headers);
    return {
      buffer: remote.buffer,
      mimeType: remote.mimeType,
      fileName: `image-${index + 1}.png`,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }
  return null;
}

function dataUrlForInputImage(image: { mimeType?: string; buffer: Buffer }): string {
  const mimeType = normalizeString(image.mimeType) || "image/png";
  return `data:${mimeType};base64,${Buffer.from(image.buffer).toString("base64")}`;
}

function buildProvider(providerId: string, pluginProviderConfig: PluginProviderConfig = {}) {
  const providerKey = normalizeId(providerId);
  if (!providerKey) return null;
  const startupCfg = readOpenClawConfig();
  const startupProviderConfig = startupCfg?.models?.providers?.[providerKey] as
    | { models?: ProviderModelConfig[] }
    | undefined;
  const startupImageModels = detectImageModels(startupProviderConfig, pluginProviderConfig);
  const label = providerLabel(providerKey, pluginProviderConfig);
  const defaultSizes =
    Array.isArray(pluginProviderConfig.sizes) && pluginProviderConfig.sizes.length > 0
      ? pluginProviderConfig.sizes
          .map(normalizeString)
          .filter((value): value is string => Boolean(value))
      : [...DEFAULT_SIZES];
  const editsEnabled = pluginProviderConfig.enableEdits !== false;
  const maxInputImages =
    Number.isFinite(pluginProviderConfig.maxInputImages) && pluginProviderConfig.maxInputImages! > 0
      ? Math.trunc(pluginProviderConfig.maxInputImages!)
      : 5;

  return {
    id: providerKey,
    label,
    defaultModel: normalizeString(pluginProviderConfig.defaultModel) || startupImageModels[0],
    models: startupImageModels,
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: editsEnabled,
        maxCount: 4,
        maxInputImages,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: { sizes: defaultSizes },
    },
    isConfigured({ cfg }: { cfg?: OpenClawConfig }) {
      const providerConfig = cfg?.models?.providers?.[providerKey] as Record<string, unknown> | undefined;
      return Boolean(
        resolvePlaceholder(pluginProviderConfig.apiKey) ||
          resolvePlaceholder(providerConfig?.apiKey) ||
          Object.keys(mergeHeaders(providerConfig, pluginProviderConfig)).length > 0,
      );
    },
    async generateImage(req: {
      cfg?: OpenClawConfig;
      model?: string;
      prompt: string;
      count?: number;
      size?: string;
      quality?: string;
      outputFormat?: string;
      background?: string;
      inputImages?: Array<{ mimeType?: string; buffer: Buffer }>;
    }) {
      const providerConfig = req.cfg?.models?.providers?.[providerKey] as Record<string, unknown> | undefined;
      const baseUrl = normalizeString(providerConfig?.baseUrl);
      if (!baseUrl) {
        throw new Error(`${label} baseUrl missing at models.providers.${providerKey}.baseUrl`);
      }
      const imageModels = detectImageModels(
        providerConfig as { models?: ProviderModelConfig[] } | undefined,
        pluginProviderConfig,
      );
      const model =
        normalizeString(req.model) || normalizeString(pluginProviderConfig.defaultModel) || imageModels[0];
      if (!model) {
        throw new Error(
          `${label} has no image models configured. Add image-capable models under models.providers.${providerKey}.models[].`,
        );
      }
      const apiKey =
        resolvePlaceholder(pluginProviderConfig.apiKey) || resolvePlaceholder(providerConfig?.apiKey);
      const headers = new Headers(mergeHeaders(providerConfig, pluginProviderConfig));
      if (apiKey && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("Content-Type", "application/json");
      const mode = (req.inputImages?.length ?? 0) > 0 ? "edit" : "generate";
      if (mode === "edit" && !editsEnabled) {
        throw new Error(`${label} image editing is disabled for this custom provider.`);
      }
      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
        n: Math.max(1, Math.min(4, Number.isFinite(req.count) ? Math.trunc(req.count as number) : 1)),
        size: normalizeString(req.size) || DEFAULT_SIZE,
      };
      const quality = normalizeString(req.quality);
      if (quality) body.quality = quality;
      const outputFormat = normalizeString(req.outputFormat);
      if (outputFormat) body.output_format = outputFormat;
      const background = normalizeString(req.background);
      if (background) body.background = background;
      if (mode === "edit") {
        body.images = (req.inputImages ?? []).map((image) => ({
          image_url: dataUrlForInputImage(image),
        }));
      }
      const endpoint = `${baseUrl.replace(/\/+$/u, "")}/images/${mode === "edit" ? "edits" : "generations"}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${label} image generation failed (${response.status})${text ? `: ${text}` : ""}`);
      }
      const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const images = [];
      for (const [index, entry] of data.entries()) {
        const parsed = await parseImageEntry(entry, index, headers);
        if (parsed) images.push(parsed);
      }
      if (images.length === 0) throw new Error(`${label} image generation response missing image data.`);
      return { images, model };
    },
  };
}

function configuredProviderIds(): string[] {
  const pluginConfig = readPluginConfig();
  const fromList = Array.isArray(pluginConfig.providerIds)
    ? pluginConfig.providerIds.map(normalizeId).filter((value): value is string => Boolean(value))
    : [];
  const fromObject = pluginConfig.providers && typeof pluginConfig.providers === "object"
    ? Object.keys(pluginConfig.providers)
        .map(normalizeId)
        .filter((value): value is string => Boolean(value))
    : [];
  return [...new Set([...fromList, ...fromObject])];
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Custom Image Providers",
  description: "Expose selected models.providers entries as OpenAI-compatible image-generation providers.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = readPluginConfig();
    for (const providerId of configuredProviderIds()) {
      const provider = buildProvider(providerId, pluginConfig.providers?.[providerId] ?? {});
      if (provider) api.registerImageGenerationProvider(provider);
    }
  },
});
