import {
  isRealtimeVoiceAgentConsultToolPolicy,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import { isSecretRef, type SecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { asRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type FaceTimeVideoConfig = {
  enabled: boolean;
  provider: string;
  width: number;
  height: number;
  frameRate: number;
  obs: {
    url: string;
    password?: SecretInput;
    sceneName: string;
    sourceName: string;
    autoStartVirtualCamera: boolean;
  };
};

export type FaceTimeConfig = {
  enabled: boolean;
  ownerHandles: string[];
  video: FaceTimeVideoConfig;
  realtime: {
    provider?: string;
    model?: string;
    voice?: string;
    sessionKey: string;
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
    instructions?: string;
    providers: Record<string, Record<string, unknown>>;
  };
};

const DEFAULT_VIDEO_CONFIG: FaceTimeVideoConfig = {
  enabled: false,
  provider: "lobster",
  width: 1_280,
  height: 720,
  frameRate: 30,
  obs: {
    url: "ws://127.0.0.1:4455",
    sceneName: "OpenClaw FaceTime Video",
    sourceName: "OpenClaw Live Visual",
    autoStartVirtualCamera: true,
  },
};

const DEFAULT_INSTRUCTIONS = [
  "You are the realtime voice surface for the configured OpenClaw agent during a private 1:1 FaceTime call.",
  "Keep replies concise, natural, and useful for a hands-free voice conversation.",
].join(" ");

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function resolveInteger(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
  path: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new Error(`${path} must be an integer from ${bounds.min} through ${bounds.max}`);
  }
  return value;
}

function resolveObsUrl(value: unknown): string {
  const normalized = normalizeOptionalString(value) ?? DEFAULT_VIDEO_CONFIG.obs.url;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("video.obs.url must be a valid WebSocket URL");
  }
  if (parsed.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("video.obs.url must use ws:// on loopback");
  }
  return parsed.toString();
}

function resolveSecretInput(value: unknown): SecretInput | undefined {
  if (value === undefined) {
    return undefined;
  }
  const literal = normalizeOptionalString(value);
  if (literal) {
    return literal;
  }
  if (isSecretRef(value)) {
    return value;
  }
  throw new Error("video.obs.password must be a string or SecretRef");
}

function resolveVideoConfig(value: unknown): FaceTimeVideoConfig {
  const raw = asRecord(value);
  const obs = asRecord(raw.obs);
  return {
    enabled: resolveBoolean(raw.enabled, DEFAULT_VIDEO_CONFIG.enabled),
    provider: normalizeOptionalString(raw.provider) ?? DEFAULT_VIDEO_CONFIG.provider,
    width: resolveInteger(
      raw.width,
      DEFAULT_VIDEO_CONFIG.width,
      { min: 320, max: 3_840 },
      "video.width",
    ),
    height: resolveInteger(
      raw.height,
      DEFAULT_VIDEO_CONFIG.height,
      { min: 240, max: 2_160 },
      "video.height",
    ),
    frameRate: resolveInteger(
      raw.frameRate,
      DEFAULT_VIDEO_CONFIG.frameRate,
      { min: 1, max: 60 },
      "video.frameRate",
    ),
    obs: {
      url: resolveObsUrl(obs.url),
      password: resolveSecretInput(obs.password),
      sceneName: normalizeOptionalString(obs.sceneName) ?? DEFAULT_VIDEO_CONFIG.obs.sceneName,
      sourceName: normalizeOptionalString(obs.sourceName) ?? DEFAULT_VIDEO_CONFIG.obs.sourceName,
      autoStartVirtualCamera: resolveBoolean(
        obs.autoStartVirtualCamera,
        DEFAULT_VIDEO_CONFIG.obs.autoStartVirtualCamera,
      ),
    },
  };
}

function resolveRealtimeVoiceAgentConsultToolPolicy(
  value: unknown,
): RealtimeVoiceAgentConsultToolPolicy {
  if (value === undefined) {
    return "owner";
  }
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!isRealtimeVoiceAgentConsultToolPolicy(normalized)) {
    throw new Error(
      `realtime.toolPolicy must be one of ${REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES.join(", ")}`,
    );
  }
  return normalized;
}

function resolveProviders(value: unknown): Record<string, Record<string, unknown>> {
  const raw = asRecord(value);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [key, providerConfig] of Object.entries(raw)) {
    const id = normalizeOptionalString(key);
    if (id) {
      providers[id] = asRecord(providerConfig);
    }
  }
  return providers;
}

export function resolveFaceTimeConfig(input: unknown): FaceTimeConfig {
  const raw = asRecord(input);
  const realtime = asRecord(raw.realtime);
  if (typeof realtime.instructions === "string" && realtime.instructions.length > 4000) {
    throw new Error("realtime.instructions must not exceed 4000 characters");
  }
  return {
    enabled: resolveBoolean(raw.enabled, true),
    ownerHandles: resolveStringArray(raw.ownerHandles),
    video: resolveVideoConfig(raw.video),
    realtime: {
      provider: normalizeOptionalString(realtime.provider),
      model: normalizeOptionalString(realtime.model),
      voice: normalizeOptionalString(realtime.voice),
      sessionKey: normalizeOptionalString(realtime.sessionKey) ?? "main",
      toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(realtime.toolPolicy),
      instructions: normalizeOptionalString(realtime.instructions) ?? DEFAULT_INSTRUCTIONS,
      providers: resolveProviders(realtime.providers),
    },
  };
}

export function validateFaceTimeConfig(config: FaceTimeConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!config.ownerHandles.length) {
    errors.push("ownerHandles must contain at least one authorized FaceTime handle");
  }
  if (process.platform !== "darwin") {
    errors.push("facetime requires macOS");
  }
  return { valid: errors.length === 0, errors };
}
