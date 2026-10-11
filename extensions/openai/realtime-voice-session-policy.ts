import { execFileSync } from "node:child_process";
import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  toOpenAICompatibleRealtimeAudioFormat,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumber,
  asFiniteNumberInRange,
  asSafeIntegerInRange,
  asOptionalObjectRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenAIChatGptSubscriptionAuth } from "./realtime-auth.js";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import {
  readRealtimeErrorDetail,
  resolveOpenAIProviderConfigRecord,
} from "./realtime-provider-shared.js";
import {
  OPENAI_GPT_LIVE_AUTH_REQUIRED,
  OPENAI_GPT_LIVE_AUTHORED_PLATFORM_AUTH_UNAVAILABLE,
  OPENAI_GPT_LIVE_PUBLIC_AUTH_REQUIRED,
  OPENAI_GPT_LIVE_PUBLIC_AUTHORED_PLATFORM_AUTH_UNAVAILABLE,
} from "./realtime-quicksilver-redaction.js";
import {
  OPENAI_GPT_LIVE_MODELS,
  isOpenAIGptLiveSubscriptionModel,
  resolveOpenAIQuicksilverVoiceCapabilities,
} from "./realtime-quicksilver.js";

export type OpenAIRealtimeVoice = (typeof OPENAI_REALTIME_VOICES)[number];

export type OpenAIRealtimeUserMessageOptions = {
  toolChoice?: { type: "function"; name: string };
};

export type OpenAIRealtimeVoiceProviderConfig = Partial<ReturnType<typeof normalizeProviderConfig>>;

export type OpenAIRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest &
  Omit<OpenAIRealtimeVoiceProviderConfig, "voice"> & {
    callId?: string;
    gaSessionPolicy?: RealtimeGaSessionPolicy;
    voice?: OpenAIRealtimeVoice;
    logger: Pick<import("openclaw/plugin-sdk/plugin-entry").PluginLogger, "warn">;
  };

export const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime-2.1";
// Picker suggestions surfaced through talk.catalog. Free-form model values are still accepted.
export const OPENAI_REALTIME_MODELS = [
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime-2",
  ...OPENAI_GPT_LIVE_MODELS,
] as const;
export const OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const OPENAI_REALTIME_CAPABILITIES: RealtimeVoiceProviderCapabilities & {
  voicesByModel: Record<string, readonly string[]>;
} = {
  voicesByModel: Object.fromEntries(
    OPENAI_GPT_LIVE_MODELS.map((model) => [
      model,
      resolveOpenAIQuicksilverVoiceCapabilities(model).voices,
    ]),
  ),
  transports: ["webrtc", "gateway-relay"],
  inputAudioFormats: [
    REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
    REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  ],
  outputAudioFormats: [
    REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
    REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  ],
  supportsBrowserSession: true,
  supportsBargeIn: true,
  handlesInputAudioBargeIn: true,
  supportsToolCalls: true,
  supportsActivationNameGating: true,
  supportsVideoFrames: true,
};
export const OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";
export const OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  "Cancellation failed: no active response found";
const OPENAI_REALTIME_MAX_SESSION_DURATION_FRAGMENT = "maximum duration";
export const OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES = 1024 * 1024;
export const OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
// Realtime validates this character set but accepts names beyond the 64-character
// cap used by other OpenAI tool surfaces.
const OPENAI_REALTIME_TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const AZURE_OPENAI_REALTIME_TOOL_NAME_MAX_LENGTH = 64;
export const OPENAI_REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

export function normalizeOpenAIRealtimeVoice(value: unknown): OpenAIRealtimeVoice | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  return OPENAI_REALTIME_VOICES.find((voice) => voice === normalized);
}

export type RealtimeEvent = {
  type: string;
  delta?: string;
  data?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  session?: unknown;
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
    output?: unknown[];
  };
  error?: unknown;
};

type RealtimeGaSessionPolicy = ReturnType<typeof buildOpenAIRealtimeGaSessionPolicy>;

function normalizeRealtimeBaseUrl(value: unknown): string | undefined {
  if (value === undefined || (typeof value === "string" && !value.trim())) {
    return undefined;
  }
  const url = typeof value === "string" ? URL.parse(value.trim()) : null;
  if (!url || !["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("Invalid OpenAI realtime baseUrl: expected an HTTP(S) or WS(S) endpoint URL");
  }
  // Never echo a configured URL: query values may contain provider credentials.
  if (url.username || url.password || url.hash) {
    throw new Error("Invalid OpenAI realtime baseUrl: credentials and fragments are not supported");
  }
  url.protocol = url.protocol.replace("http", "ws");
  return url.toString();
}

export function normalizeProviderConfig(config: RealtimeVoiceProviderConfig) {
  const raw = resolveOpenAIProviderConfigRecord(config);
  const baseUrl = normalizeRealtimeBaseUrl(raw?.baseUrl);
  const azureEndpoint = normalizeOptionalString(raw?.azureEndpoint);
  const azureDeployment = normalizeOptionalString(raw?.azureDeployment);
  if (baseUrl && (azureEndpoint || azureDeployment)) {
    throw new Error("OpenAI realtime baseUrl cannot be combined with Azure endpoint or deployment");
  }
  return {
    baseUrl,
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "plugins.entries.voice-call.config.realtime.providers.openai.apiKey",
    }),
    model: normalizeOptionalString(raw?.model),
    // Session creation selects the effective model; an earlier family fallback loses overrides.
    voice: normalizeOptionalLowercaseString(raw?.speakerVoice ?? raw?.voice),
    temperature: asFiniteNumber(raw?.temperature),
    vadThreshold: asFiniteNumberInRange(raw?.vadThreshold, { min: 0, max: 1 }),
    silenceDurationMs: asSafeIntegerInRange(raw?.silenceDurationMs, { min: 0 }),
    prefixPaddingMs: asSafeIntegerInRange(raw?.prefixPaddingMs, { min: 0 }),
    interruptResponseOnInputAudio:
      typeof raw?.interruptResponseOnInputAudio === "boolean"
        ? raw.interruptResponseOnInputAudio
        : undefined,
    minBargeInAudioEndMs: asSafeIntegerInRange(raw?.minBargeInAudioEndMs, { min: 0 }),
    reasoningEffort: normalizeOptionalString(raw?.reasoningEffort),
    azureEndpoint,
    azureDeployment,
    azureApiVersion: normalizeOptionalString(raw?.azureApiVersion),
  };
}

export const OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED =
  "OpenAI Realtime voice requires an OpenAI Platform API key";
export const OPENAI_REALTIME_API_KEY_REQUIRED = "OpenAI Realtime voice requires an API key";
export const OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED =
  "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source";
const KEYCHAIN_SECRET_REF_RE = /^keychain:([^:]+):([^:]+)$/;
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 5000;
const resolvedKeychainSecretRefCache = new Map<string, string>();

export function isDirectOpenAIRealtimeWebSocketUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export function isOpenAIRealtimeStartupAuthFailure(error: unknown): boolean {
  const record = asOptionalObjectRecord(error);
  const status = record?.status ?? record?.statusCode;
  const rawCode = record?.code ?? record?.errorCode;
  const code = typeof rawCode === "string" ? rawCode.toLowerCase() : "";
  const message = readRealtimeErrorDetail(error).toLowerCase();
  return (
    status === 401 ||
    code === "invalid_api_key" ||
    message.includes("invalid_api_key") ||
    message.includes("incorrect api key provided") ||
    message.includes("unexpected server response: 401")
  );
}

function resolveKeychainSecretRef(value: string): string | undefined {
  const trimmed = value.trim();
  const match = KEYCHAIN_SECRET_REF_RE.exec(trimmed);
  if (!match) {
    return trimmed || undefined;
  }
  const cached = resolvedKeychainSecretRefCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const [, service, account] = match;
  if (!service || !account) {
    return undefined;
  }
  try {
    const resolved =
      execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS,
        },
      ).trim() || undefined;
    if (resolved) {
      resolvedKeychainSecretRefCache.set(trimmed, resolved);
    }
    return resolved;
  } catch {
    return undefined;
  }
}

export function resolveOpenAIRealtimeSecretInput(
  configuredApiKey: string | undefined,
): string | undefined {
  const configured = normalizeSecretInputString(configuredApiKey);
  return configured ? resolveKeychainSecretRef(configured) : undefined;
}

export function requireOpenAIRealtimeApiKey(
  configuredApiKey: string | undefined,
  errorMessage = OPENAI_REALTIME_API_KEY_REQUIRED,
): string {
  const configured = resolveOpenAIRealtimeSecretInput(configuredApiKey);
  const resolved =
    configured || hasOpenAIRealtimeConfiguredApiKeyInput(configuredApiKey)
      ? configured
      : resolveOpenAIRealtimeSecretInput(process.env.OPENAI_API_KEY);
  if (resolved) {
    return resolved;
  }
  throw new Error(errorMessage);
}

export function hasOpenAIRealtimeConfiguredApiKeyInput(
  configuredApiKey: string | undefined,
): boolean {
  return Boolean(normalizeSecretInputString(configuredApiKey));
}

export function hasOpenAIRealtimeApiKeyInput(configuredApiKey: string | undefined): boolean {
  return Boolean(
    normalizeSecretInputString(configuredApiKey) ??
    normalizeSecretInputString(process.env.OPENAI_API_KEY),
  );
}

export function normalizeOpenAIRealtimeTools(
  tools: RealtimeVoiceTool[] | undefined,
  warn: OpenAIRealtimeHost["warn"],
  maxNameLength?: number,
): RealtimeVoiceTool[] | undefined {
  const normalized: RealtimeVoiceTool[] = [];
  let omitted = 0;
  for (const tool of tools ?? []) {
    try {
      const name = tool.name;
      if (typeof name !== "string") {
        omitted += 1;
        continue;
      }
      const exceedsLengthLimit = maxNameLength !== undefined && name.length > maxNameLength;
      if (exceedsLengthLimit || !OPENAI_REALTIME_TOOL_NAME_RE.test(name)) {
        omitted += 1;
        continue;
      }
      normalized.push({
        type: "function",
        name,
        description: tool.description,
        parameters: tool.parameters,
      });
    } catch {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    warn(`openai realtime: omitted ${omitted} tool definition(s) with unsupported names`);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function buildOpenAIRealtimeTurnDetectionConfig(params: {
  autoRespondToAudio?: boolean;
  createResponse?: boolean;
  includeInterruptResponse?: boolean;
  interruptResponseOnInputAudio?: boolean;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  vadThreshold?: number;
}) {
  const configuredAutoResponse = params.autoRespondToAudio ?? true;
  return {
    type: "server_vad" as const,
    threshold: params.vadThreshold ?? 0.5,
    prefix_padding_ms: params.prefixPaddingMs ?? 300,
    silence_duration_ms: params.silenceDurationMs ?? 500,
    create_response: params.createResponse ?? configuredAutoResponse,
    ...(params.includeInterruptResponse
      ? {
          interrupt_response: params.interruptResponseOnInputAudio ?? configuredAutoResponse,
        }
      : {}),
  };
}

export function buildOpenAIRealtimeGaSessionPolicy(params: {
  audioFormat?: RealtimeVoiceAudioFormat;
  autoRespondToAudio?: boolean;
  instructions?: string;
  interruptResponseOnInputAudio?: boolean;
  language?: string;
  model: string;
  noiseReduction: { type: "near_field" } | null;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
  silenceDurationMs?: number;
  tools?: RealtimeVoiceTool[];
  vadThreshold?: number;
  voice: OpenAIRealtimeVoice;
}) {
  const format = toOpenAICompatibleRealtimeAudioFormat(
    params.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  );
  return {
    type: "realtime" as const,
    model: params.model,
    ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
    output_modalities: ["audio"],
    audio: {
      input: {
        format,
        noise_reduction: params.noiseReduction,
        transcription: {
          model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL,
          ...(params.language ? { language: params.language } : {}),
        },
        turn_detection: buildOpenAIRealtimeTurnDetectionConfig({
          autoRespondToAudio: params.autoRespondToAudio,
          includeInterruptResponse: true,
          interruptResponseOnInputAudio: params.interruptResponseOnInputAudio,
          prefixPaddingMs: params.prefixPaddingMs,
          silenceDurationMs: params.silenceDurationMs,
          vadThreshold: params.vadThreshold,
        }),
      },
      output: {
        format,
        voice: params.voice,
      },
    },
    ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
    ...(params.tools ? { tools: params.tools, tool_choice: "auto" } : {}),
  };
}

export async function resolveOpenAIRealtimePlatformAuth(
  params: {
    configuredApiKey: string | undefined;
    cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
    agentId?: string;
  },
  runtime: OpenAIRealtimeHost,
): Promise<string | undefined> {
  const configured = resolveOpenAIRealtimeSecretInput(params.configuredApiKey);
  if (configured || hasOpenAIRealtimeConfiguredApiKeyInput(params.configuredApiKey)) {
    return configured;
  }

  const { resolveProviderAuthProfileApiKey, resolveAgentDir } = runtime;
  const profileApiKey = await resolveProviderAuthProfileApiKey({
    provider: "openai",
    cfg: params.cfg,
    ...(params.cfg && params.agentId
      ? { agentDir: resolveAgentDir(params.cfg, params.agentId) }
      : {}),
    profileTypes: ["api_key"],
    includeExternalCliAuth: false,
  });
  return profileApiKey || resolveOpenAIRealtimeSecretInput(process.env.OPENAI_API_KEY);
}

export async function requireOpenAIRealtimePlatformAuth(
  params: Parameters<typeof resolveOpenAIRealtimePlatformAuth>[0],
  runtime: OpenAIRealtimeHost,
): Promise<string> {
  const resolved = await resolveOpenAIRealtimePlatformAuth(params, runtime);
  if (resolved) {
    return resolved;
  }
  throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
}

export async function resolveOpenAIQuicksilverBridgeAuth(
  params: Parameters<typeof resolveOpenAIRealtimePlatformAuth>[0] & {
    model: string;
  },
  runtime: OpenAIRealtimeHost,
) {
  if (isOpenAIGptLiveSubscriptionModel(params.model)) {
    const { resolveAgentDir } = runtime;
    const subscriptionAuth = await resolveOpenAIChatGptSubscriptionAuth(
      {
        cfg: params.cfg,
        agentDir:
          params.cfg && params.agentId ? resolveAgentDir(params.cfg, params.agentId) : undefined,
      },
      runtime,
    );
    if (subscriptionAuth) {
      return subscriptionAuth;
    }
  }
  const platformAuth = await resolveOpenAIRealtimePlatformAuth(params, runtime);
  if (platformAuth) {
    return { type: "api-key" as const, token: platformAuth };
  }
  if (hasOpenAIRealtimePlatformAuthInput(params, runtime)) {
    throw new Error(
      isOpenAIGptLiveSubscriptionModel(params.model)
        ? OPENAI_GPT_LIVE_PUBLIC_AUTHORED_PLATFORM_AUTH_UNAVAILABLE
        : OPENAI_GPT_LIVE_AUTHORED_PLATFORM_AUTH_UNAVAILABLE,
    );
  }
  throw new Error(
    isOpenAIGptLiveSubscriptionModel(params.model)
      ? OPENAI_GPT_LIVE_PUBLIC_AUTH_REQUIRED
      : OPENAI_GPT_LIVE_AUTH_REQUIRED,
  );
}

export function hasOpenAIRealtimePlatformAuthInput(
  params: Parameters<typeof resolveOpenAIRealtimePlatformAuth>[0],
  {
    isProviderAuthProfileConfigured,
    resolveAgentDir,
  }: Pick<PluginCapabilityCatalogContext, "isProviderAuthProfileConfigured" | "resolveAgentDir">,
): boolean {
  if (hasOpenAIRealtimeConfiguredApiKeyInput(params.configuredApiKey)) {
    return true;
  }
  if (
    isProviderAuthProfileConfigured({
      provider: "openai",
      cfg: params.cfg,
      ...(params.cfg && params.agentId
        ? { agentDir: resolveAgentDir(params.cfg, params.agentId) }
        : {}),
      profileTypes: ["api_key"],
      includeExternalCliAuth: false,
    })
  ) {
    return true;
  }
  return hasOpenAIRealtimeApiKeyInput(undefined);
}

export function hasOpenAIChatGptSubscriptionAuthInput(
  params: {
    cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
    agentId?: string;
  },
  {
    isProviderAuthProfileConfigured,
    resolveAgentDir,
  }: Pick<PluginCapabilityCatalogContext, "isProviderAuthProfileConfigured" | "resolveAgentDir">,
): boolean {
  return isProviderAuthProfileConfigured({
    provider: "openai",
    capability: "realtime-voice",
    cfg: params.cfg,
    agentDir:
      params.cfg && params.agentId ? resolveAgentDir(params.cfg, params.agentId) : undefined,
    profileTypes: ["oauth"],
    includeExternalCliAuth: false,
  });
}

export function isOpenAIRealtimeMaxSessionDurationError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("session") &&
    normalized.includes(OPENAI_REALTIME_MAX_SESSION_DURATION_FRAGMENT)
  );
}

export function parsePlaybackMarkSequence(markName: string): number | undefined {
  const match = /^audio-(\d+)$/u.exec(markName);
  if (!match) {
    return undefined;
  }
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}
