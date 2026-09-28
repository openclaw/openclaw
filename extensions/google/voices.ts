import type { sanitizeConfiguredModelProviderRequest } from "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import type {
  SpeechDesignVoiceRequest,
  SpeechDesignVoiceResult,
  SpeechListVoicesRequest,
  SpeechListVoicesResult,
  SpeechProviderConfig,
  SpeechReplicateVoiceRequest,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech-core";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { canonicalizeGoogleProviderBase64 } from "./base64.js";
import { GOOGLE_PREBUILT_VOICES } from "./voice-catalog.js";

const GOOGLE_VOICE_DESIGN_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"] as const;
const DEFAULT_GOOGLE_VOICE_DESIGN_MODEL = GOOGLE_VOICE_DESIGN_MODELS[0];
const MAX_VOICE_PAGES = 10;
const MAX_PROMPT_CHARS = 2_000;
const VOICE_HTTP_RETRY_LIMIT = 3;

type GoogleHttpRequest = ReturnType<typeof sanitizeConfiguredModelProviderRequest>;

export type GoogleVoiceDesignRequest = {
  apiKey: string;
  baseUrl?: string;
  request?: GoogleHttpRequest;
  timeoutMs: number;
  displayName: string;
  prompt: string;
  languageCode?: string;
  gender?: string;
  model?: string;
  assertCurrent?: () => void;
};

export type GoogleVoiceDesignResult = {
  id: string;
  name: string;
  preview: Buffer;
  mimeType: string;
};

function trim(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function readVoiceId(record: Record<string, unknown>): string | undefined {
  const explicit = trim(record.id) ?? trim(record.voice_id) ?? trim(record.voiceId);
  const name = trim(record.name);
  const raw = explicit ?? name;
  if (!raw) {
    return undefined;
  }
  return raw.startsWith("voices/") ? raw.slice("voices/".length) : raw;
}

function readVoiceOption(value: unknown): SpeechVoiceOption | undefined {
  const record = asOptionalRecord(value);
  const id = record ? readVoiceId(record) : undefined;
  if (!record || !id) {
    return undefined;
  }
  const name = trim(record.display_name) ?? trim(record.displayName) ?? trim(record.name) ?? id;
  const category = trim(record.type);
  const description = trim(record.description);
  const locale = trim(record.language_code) ?? trim(record.languageCode);
  const gender = trim(record.gender);
  return {
    id,
    name,
    ...(category ? { category } : {}),
    ...(description ? { description } : {}),
    ...(locale ? { locale } : {}),
    ...(gender ? { gender } : {}),
  };
}

function readPreview(
  record: Record<string, unknown>,
): { data: string; mimeType: string } | undefined {
  const raw =
    record.sample_audio ?? record.sampleAudio ?? record.preview_audio ?? record.previewAudio;
  if (typeof raw === "string" && raw.trim()) {
    return { data: raw.trim(), mimeType: "audio/wav" };
  }
  const audio = asOptionalRecord(raw);
  const data = trim(audio?.data);
  if (!data) {
    return undefined;
  }
  return {
    data,
    mimeType: trim(audio?.mime_type) ?? trim(audio?.mimeType) ?? "audio/wav",
  };
}

async function resolveGoogleVoiceHttp(params: {
  apiKey: string;
  baseUrl?: string;
  request?: GoogleHttpRequest;
}) {
  const { resolveGoogleGenerativeAiHttpRequestConfig } = await import("./api.js");
  return resolveGoogleGenerativeAiHttpRequestConfig({
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    request: params.request,
    capability: "audio",
    transport: "http",
  });
}

function isRetryableGoogleVoiceHttpError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const status = Number(record.status ?? record.statusCode);
  const code = String(record.code ?? "");
  const message = String(record.message ?? error);
  return (
    status === 503 ||
    code === "UNAVAILABLE" ||
    /\b503\b|UNAVAILABLE|currently unavailable/i.test(message)
  );
}

function voiceHttpRetryDelayMs(attempt: number): number {
  if (process.env.VITEST) {
    return 0;
  }
  return 500 * 2 ** attempt;
}

async function googleVoicesFetchOnce(params: {
  apiKey: string;
  baseUrl?: string;
  request?: GoogleHttpRequest;
  timeoutMs: number;
  url: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  assertCurrent?: () => void;
}): Promise<Record<string, unknown>> {
  const {
    assertOkOrThrowProviderError,
    fetchWithTimeoutGuarded,
    postJsonRequest,
    readProviderJsonResponse,
  } = await import("openclaw/plugin-sdk/provider-http");
  const http = await resolveGoogleVoiceHttp(params);
  const guarded = {
    pinDns: false as const,
    ...(http.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
    ...(http.dispatcherPolicy ? { dispatcherPolicy: http.dispatcherPolicy } : {}),
  };
  const posted = params.method === "POST";
  const send = async () => {
    const { response, release } = posted
      ? await postJsonRequest({
          url: params.url,
          headers: http.headers,
          body: params.body,
          timeoutMs: params.timeoutMs,
          fetchFn: fetch,
          pinDns: false,
          allowPrivateNetwork: http.allowPrivateNetwork,
          dispatcherPolicy: http.dispatcherPolicy,
        })
      : await fetchWithTimeoutGuarded(
          params.url,
          { method: "GET", headers: http.headers },
          params.timeoutMs,
          fetch,
          guarded,
        );
    try {
      if (!response.ok) {
        await assertOkOrThrowProviderError(response, "Google voices request failed");
      }
      const payload = await readProviderJsonResponse<unknown>(response, "Google voices response");
      const record = asOptionalRecord(payload);
      if (!record) {
        throw new Error("Google voices response was not an object");
      }
      return record;
    } finally {
      await release();
    }
  };
  if (!posted) {
    return await send();
  }
  const { withGuardedFetchRequestAuthority } = await import("openclaw/plugin-sdk/ssrf-runtime");
  return await withGuardedFetchRequestAuthority(params.assertCurrent, send);
}

async function googleVoicesFetch(params: {
  apiKey: string;
  baseUrl?: string;
  request?: GoogleHttpRequest;
  timeoutMs: number;
  url: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  assertCurrent?: () => void;
}): Promise<Record<string, unknown>> {
  if (params.method !== "GET") {
    // CreateVoice with store:true is not idempotent. A 503 after the voice is
    // stored would mint a duplicate on retry.
    return await googleVoicesFetchOnce(params);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < VOICE_HTTP_RETRY_LIMIT; attempt += 1) {
    try {
      return await googleVoicesFetchOnce(params);
    } catch (error) {
      lastError = error;
      if (!isRetryableGoogleVoiceHttpError(error) || attempt === VOICE_HTTP_RETRY_LIMIT - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, voiceHttpRetryDelayMs(attempt)));
    }
  }
  throw lastError;
}

export async function listGoogleProjectVoices(params: {
  apiKey: string;
  baseUrl?: string;
  request?: GoogleHttpRequest;
  timeoutMs: number;
}): Promise<SpeechVoiceOption[]> {
  const http = await resolveGoogleVoiceHttp(params);
  const voices: SpeechVoiceOption[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_VOICE_PAGES; page += 1) {
    const url = new URL(`${http.baseUrl}/voices`);
    url.searchParams.set("page_size", "100");
    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }
    const payload = await googleVoicesFetch({
      ...params,
      url: url.toString(),
      method: "GET",
    });
    const listed = Array.isArray(payload.voices) ? payload.voices : [];
    for (const entry of listed) {
      const voice = readVoiceOption(entry);
      if (!voice || seen.has(voice.id)) {
        continue;
      }
      seen.add(voice.id);
      voices.push(voice);
    }
    pageToken = trim(payload.next_page_token) ?? trim(payload.nextPageToken);
    if (!pageToken) {
      break;
    }
  }
  return voices;
}

function assertDesignInput(params: GoogleVoiceDesignRequest): {
  displayName: string;
  prompt: string;
  model: string;
  languageCode?: string;
  gender?: string;
} {
  const displayName = trim(params.displayName);
  const prompt = trim(params.prompt);
  const model = trim(params.model) ?? DEFAULT_GOOGLE_VOICE_DESIGN_MODEL;
  if (!displayName) {
    throw new Error("Google voice design requires a display name");
  }
  if (!prompt) {
    throw new Error("Google voice design requires a prompt");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Google voice design prompt must be ${MAX_PROMPT_CHARS} characters or fewer`);
  }
  if (!GOOGLE_VOICE_DESIGN_MODELS.includes(model as (typeof GOOGLE_VOICE_DESIGN_MODELS)[number])) {
    throw new Error(
      `Google voice design model ${model} is not supported. Use ${GOOGLE_VOICE_DESIGN_MODELS.join(" or ")}.`,
    );
  }
  const languageCode = trim(params.languageCode);
  if (languageCode && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(languageCode)) {
    throw new Error(`Invalid Google voice design language code: ${languageCode}`);
  }
  const gender = trim(params.gender)?.toLowerCase();
  if (gender && !/^[a-z]{3,20}$/.test(gender)) {
    throw new Error(`Invalid Google voice design gender: ${gender}`);
  }
  return {
    displayName,
    prompt,
    model,
    ...(languageCode ? { languageCode } : {}),
    ...(gender ? { gender } : {}),
  };
}

type GoogleVoiceMethodDeps = {
  readConfig: (config: SpeechProviderConfig) => { baseUrl?: string };
  resolveApiKey: (params: {
    cfg?: OpenClawConfig;
    providerConfig: SpeechProviderConfig;
  }) => string | undefined;
  resolveBaseUrl: (params: {
    cfg?: OpenClawConfig;
    providerConfig: { baseUrl?: string };
  }) => string | undefined;
};

function staticGoogleVoices(): SpeechVoiceOption[] {
  return GOOGLE_PREBUILT_VOICES.map((voice) => ({ id: voice, name: voice }));
}

function mergeGoogleVoiceCatalog(project: SpeechVoiceOption[]): SpeechVoiceOption[] {
  const seen = new Set<string>();
  const merged: SpeechVoiceOption[] = [];
  for (const voice of [...project, ...staticGoogleVoices()]) {
    if (seen.has(voice.id)) {
      continue;
    }
    seen.add(voice.id);
    merged.push(voice);
  }
  return merged;
}

function markProjectVoiceListingIncomplete(voices: SpeechVoiceOption[]): SpeechListVoicesResult {
  return Object.assign(voices, { projectListingIncomplete: true as const });
}

export function createGoogleSpeechVoiceMethods(deps: GoogleVoiceMethodDeps): {
  listVoices: (req: SpeechListVoicesRequest) => Promise<SpeechListVoicesResult>;
  designVoice: (req: SpeechDesignVoiceRequest) => Promise<SpeechDesignVoiceResult>;
  replicateVoice: (req: SpeechReplicateVoiceRequest) => Promise<SpeechDesignVoiceResult>;
} {
  const resolveTransport = async (
    req: SpeechListVoicesRequest | SpeechDesignVoiceRequest | SpeechReplicateVoiceRequest,
  ) => {
    const providerConfig = req.providerConfig ?? {};
    const config = deps.readConfig(providerConfig);
    const apiKey = trim(req.apiKey) ?? deps.resolveApiKey({ cfg: req.cfg, providerConfig });
    const { sanitizeConfiguredModelProviderRequest } =
      await import("openclaw/plugin-sdk/provider-http");
    return {
      apiKey,
      baseUrl:
        (apiKey ? deps.resolveBaseUrl({ cfg: req.cfg, providerConfig: config }) : undefined) ??
        req.baseUrl,
      request: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.google?.request),
    };
  };
  return {
    listVoices: async (req) => {
      const transport = await resolveTransport(req);
      if (!transport.apiKey) {
        return staticGoogleVoices();
      }
      try {
        return mergeGoogleVoiceCatalog(
          await listGoogleProjectVoices({
            apiKey: transport.apiKey,
            baseUrl: transport.baseUrl,
            request: transport.request,
            timeoutMs: req.timeoutMs ?? 30_000,
          }),
        );
      } catch {
        return markProjectVoiceListingIncomplete(staticGoogleVoices());
      }
    },
    designVoice: async (req) => {
      const transport = await resolveTransport(req);
      if (!transport.apiKey) {
        throw new Error("Google API key missing");
      }
      const designed = await designGooglePromptedVoice({
        apiKey: transport.apiKey,
        baseUrl: transport.baseUrl,
        request: transport.request,
        timeoutMs: req.timeoutMs ?? 60_000,
        displayName: req.displayName,
        prompt: req.prompt,
        languageCode: req.languageCode,
        gender: req.gender,
        model: req.model,
        assertCurrent: req.assertCurrent,
      });
      return {
        id: designed.id,
        name: designed.name,
        previewAudio: designed.preview,
        mimeType: designed.mimeType,
      };
    },
    replicateVoice: async (req) => {
      const transport = await resolveTransport(req);
      if (!transport.apiKey) {
        throw new Error("Google API key missing");
      }
      const replicated = await replicateGoogleVoice({
        apiKey: transport.apiKey,
        baseUrl: transport.baseUrl,
        request: transport.request,
        timeoutMs: req.timeoutMs ?? 60_000,
        displayName: req.displayName,
        sourceAudio: req.sourceAudio,
        consentAudio: req.consentAudio,
        sourceMimeType: req.sourceMimeType,
        consentMimeType: req.consentMimeType,
        model: req.model,
        assertCurrent: req.assertCurrent,
      });
      return {
        id: replicated.id,
        name: replicated.name,
        previewAudio: replicated.preview,
        mimeType: replicated.mimeType,
      };
    },
  };
}

export async function designGooglePromptedVoice(
  params: GoogleVoiceDesignRequest,
): Promise<GoogleVoiceDesignResult> {
  const input = assertDesignInput(params);
  const http = await resolveGoogleVoiceHttp(params);
  const payload = await googleVoicesFetch({
    ...params,
    url: `${http.baseUrl}/voices`,
    method: "POST",
    body: {
      store: true,
      voice: {
        model: input.model,
        type: "prompted",
        display_name: input.displayName,
        ...(input.languageCode ? { language_code: input.languageCode } : {}),
        ...(input.gender ? { gender: input.gender } : {}),
        prompted: { input: input.prompt },
      },
    },
  });
  return parseStoredGoogleVoice(payload, input.displayName, "design");
}

function audioBlob(
  audio: Buffer,
  mimeType: string | undefined,
): { mime_type: string; data: string } {
  if (audio.length === 0) {
    throw new Error("Google voice replication requires non-empty source and consent recordings");
  }
  return {
    mime_type: mimeType?.trim() || "audio/wav",
    data: audio.toString("base64"),
  };
}

function parseStoredGoogleVoice(
  payload: Record<string, unknown>,
  fallbackName: string,
  action: "design" | "replication",
): GoogleVoiceDesignResult {
  const voice = asOptionalRecord(payload.voice) ?? payload;
  const id = readVoiceId(voice);
  const preview = readPreview(voice) ?? readPreview(payload);
  if (!id?.startsWith("voice_")) {
    throw new Error(`Google voice ${action} response did not include a voice_ id`);
  }
  const name = trim(voice.display_name) ?? trim(voice.displayName) ?? fallbackName;
  // CreateVoice leaves sample_audio unset for replicated voices; prompted voices
  // still return a preview clip. https://ai.google.dev/api/voices
  if (!preview) {
    if (action === "replication") {
      return { id, name, preview: Buffer.alloc(0), mimeType: "audio/wav" };
    }
    throw new Error(`Google voice ${action} response missing preview audio`);
  }
  const canonical = canonicalizeGoogleProviderBase64(preview.data);
  if (!canonical) {
    throw new Error(`Google voice ${action} returned malformed preview audio`);
  }
  return {
    id,
    name,
    preview: Buffer.from(canonical, "base64"),
    mimeType: preview.mimeType,
  };
}

export type GoogleVoiceReplicateRequest = {
  apiKey: string;
  baseUrl?: string;
  request?: GoogleHttpRequest;
  timeoutMs: number;
  displayName: string;
  sourceAudio: Buffer;
  consentAudio: Buffer;
  sourceMimeType?: string;
  consentMimeType?: string;
  model?: string;
  assertCurrent?: () => void;
};

export async function replicateGoogleVoice(
  params: GoogleVoiceReplicateRequest,
): Promise<GoogleVoiceDesignResult> {
  const displayName = trim(params.displayName);
  if (!displayName) {
    throw new Error("Google voice replication requires a display name");
  }
  const model = trim(params.model) ?? DEFAULT_GOOGLE_VOICE_DESIGN_MODEL;
  if (!GOOGLE_VOICE_DESIGN_MODELS.includes(model as (typeof GOOGLE_VOICE_DESIGN_MODELS)[number])) {
    throw new Error(`Unsupported Google voice replication model: ${model}`);
  }
  const http = await resolveGoogleVoiceHttp(params);
  const payload = await googleVoicesFetch({
    ...params,
    url: `${http.baseUrl}/voices`,
    method: "POST",
    body: {
      store: true,
      voice: {
        model,
        type: "replicated",
        display_name: displayName,
        replicated: {
          source_audio: audioBlob(params.sourceAudio, params.sourceMimeType),
          consent_audio: audioBlob(params.consentAudio, params.consentMimeType),
        },
      },
    },
  });
  return parseStoredGoogleVoice(payload, displayName, "replication");
}
