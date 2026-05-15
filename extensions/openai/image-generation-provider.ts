import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationResult,
} from "openclaw/plugin-sdk/image-generation";
import {
  parseOpenAiCompatibleImageResponse,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveClosestSize } from "openclaw/plugin-sdk/media-generation-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import {
  ensureAuthProfileStore,
  isProviderApiKeyConfigured,
  listProfilesForProvider,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { canonicalizeCodexResponsesBaseUrl, OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url.js";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";
import { resolveConfiguredOpenAIBaseUrl } from "./shared.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL = OPENAI_CODEX_RESPONSES_BASE_URL;
const DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL = "gpt-5.5";
const OPENAI_CODEX_IMAGE_INSTRUCTIONS = "You are an image generation assistant.";
const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-1.5";
const DEFAULT_OPENAI_IMAGE_TIMEOUT_MS = 180_000;
const DEFAULT_AZURE_OPENAI_IMAGE_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_OUTPUT_EXTENSION = "png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const OPENAI_LEGACY_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const OPENAI_MAX_INPUT_IMAGES = 5;
const OPENAI_MAX_IMAGE_RESULTS = 4;
const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_IMAGE_SSE_EVENTS = 512;
const MAX_CODEX_IMAGE_BASE64_CHARS = 64 * 1024 * 1024;
const LOG_VALUE_MAX_CHARS = 256;
const MOCK_OPENAI_PROVIDER_ID = "mock-openai";
const OPENAI_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const OPENAI_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const OPENAI_QUALITIES = ["low", "medium", "high", "auto"] as const;
const OPENAI_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
const log = createSubsystemLogger("image-generation/openai");

const AZURE_HOSTNAME_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
] as const;

const DEFAULT_AZURE_OPENAI_API_VERSION = "preview";

function sanitizeLogValue(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  const cleaned = raw
    .replace(/[
