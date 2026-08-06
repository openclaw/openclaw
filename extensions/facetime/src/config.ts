const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
const REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES = ["safe-read-only", "owner", "none"] as const;
type RealtimeVoiceAgentConsultToolPolicy =
  (typeof REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES)[number];

export type FaceTimeConfig = {
  enabled: boolean;
  helperHost: string;
  helperPort: number;
  whitelistHandles: string[];
  realtime: {
    provider: string;
    model: string;
    voice: string;
    sessionKey: string;
    brain: "agent-consult";
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
    instructions?: string;
    providers: Record<string, Record<string, unknown>>;
  };
};

const HELPER_BASE_PORT = 45670;

const DEFAULT_INSTRUCTIONS = [
  "You are the realtime voice surface for the configured OpenClaw agent during a private 1:1 FaceTime call.",
  "Keep replies concise, natural, and useful for a hands-free voice conversation.",
].join(" ");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolvePort(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function resolveStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function resolveRealtimeVoiceAgentConsultToolPolicy(
  value: unknown,
  fallback: RealtimeVoiceAgentConsultToolPolicy,
): RealtimeVoiceAgentConsultToolPolicy {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES.includes(
    normalized as RealtimeVoiceAgentConsultToolPolicy,
  )
    ? (normalized as RealtimeVoiceAgentConsultToolPolicy)
    : fallback;
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

export function defaultFaceTimeHelperPort(
  uid = typeof process.getuid === "function" ? process.getuid() : 501,
) {
  return Math.min(Math.max(HELPER_BASE_PORT + uid - 501, HELPER_BASE_PORT), 65535);
}

export function resolveFaceTimeConfig(input: unknown): FaceTimeConfig {
  const raw = asRecord(input);
  const realtime = asRecord(raw.realtime);
  const helperPort = resolvePort(raw.helperPort, defaultFaceTimeHelperPort());
  return {
    enabled: resolveBoolean(raw.enabled, true),
    helperHost: normalizeOptionalString(raw.helperHost) ?? "127.0.0.1",
    helperPort,
    whitelistHandles: resolveStringArray(raw.whitelistHandles),
    realtime: {
      provider: normalizeOptionalString(realtime.provider) ?? "openai",
      // TODO(gpt-live): Add GPT-Live-1 and GPT-Live-1 mini when OpenAI exposes them via the API.
      // They currently return `invalid_model`; review full-duplex transport semantics before enabling them.
      model: normalizeOptionalString(realtime.model) ?? "gpt-realtime-2.1",
      voice: normalizeOptionalString(realtime.voice) ?? "marin",
      sessionKey: normalizeOptionalString(realtime.sessionKey) ?? "main",
      brain: "agent-consult",
      toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(realtime.toolPolicy, "owner"),
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
  if (!config.whitelistHandles.length) {
    errors.push("whitelistHandles must contain at least one allowed FaceTime handle");
  }
  if (process.platform !== "darwin") {
    errors.push("facetime requires macOS");
  }
  return { valid: errors.length === 0, errors };
}
