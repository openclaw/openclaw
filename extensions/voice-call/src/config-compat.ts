import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VoiceCallConfig } from "./config.js";
import { VoiceCallConfigSchema } from "./config.js";

/** Release where doctor-only legacy voice-call config support is scheduled for removal. */
export const VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION = "2026.6.0";

type VoiceCallLegacyConfigIssue = {
  /** Legacy config path relative to the voice-call plugin config object. */
  path: string;
  /** Canonical path or object that replaces the legacy key. */
  replacement: string;
  /** Operator-facing explanation shown in warnings and doctor output. */
  message: string;
};

const asObject = asOptionalRecord;
const getString = readStringField;

function getNumber(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = obj?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mergeProviderConfig(
  providersValue: unknown,
  providerId: string,
  compatValues: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (Object.keys(compatValues).length === 0) {
    return asObject(providersValue);
  }

  const providers = asObject(providersValue) ?? {};
  const existing = asObject(providers[providerId]) ?? {};
  return {
    ...providers,
    [providerId]: {
      ...existing,
      ...compatValues,
    },
  };
}

/** Collects legacy voice-call config keys that runtime load accepts only through doctor migration. */
export function collectVoiceCallLegacyConfigIssues(value: unknown): VoiceCallLegacyConfigIssue[] {
  const raw = asObject(value) ?? {};
  const realtime = asObject(raw.realtime);
  const realtimeAgentContext = asObject(realtime?.agentContext);
  const twilio = asObject(raw.twilio);
  const streaming = asObject(raw.streaming);

  const issues: VoiceCallLegacyConfigIssue[] = [];
  if (raw.provider === "log") {
    issues.push({
      path: "provider",
      replacement: "provider",
      message: 'Replace provider "log" with "mock".',
    });
  }
  if (typeof twilio?.from === "string") {
    issues.push({
      path: "twilio.from",
      replacement: "fromNumber",
      message: "Move twilio.from to fromNumber.",
    });
  }
  if (typeof streaming?.sttProvider === "string") {
    issues.push({
      path: "streaming.sttProvider",
      replacement: "streaming.provider",
      message: "Move streaming.sttProvider to streaming.provider.",
    });
  }
  if (typeof streaming?.openaiApiKey === "string") {
    issues.push({
      path: "streaming.openaiApiKey",
      replacement: "streaming.providers.openai.apiKey",
      message: "Move streaming.openaiApiKey to streaming.providers.openai.apiKey.",
    });
  }
  if (typeof streaming?.sttModel === "string") {
    issues.push({
      path: "streaming.sttModel",
      replacement: "streaming.providers.openai.model",
      message: "Move streaming.sttModel to streaming.providers.openai.model.",
    });
  }
  if (typeof streaming?.silenceDurationMs === "number") {
    issues.push({
      path: "streaming.silenceDurationMs",
      replacement: "streaming.providers.openai.silenceDurationMs",
      message: "Move streaming.silenceDurationMs to streaming.providers.openai.silenceDurationMs.",
    });
  }
  if (typeof streaming?.vadThreshold === "number") {
    issues.push({
      path: "streaming.vadThreshold",
      replacement: "streaming.providers.openai.vadThreshold",
      message: "Move streaming.vadThreshold to streaming.providers.openai.vadThreshold.",
    });
  }
  if (realtimeAgentContext && Object.hasOwn(realtimeAgentContext, "includeSystemPrompt")) {
    issues.push({
      path: "realtime.agentContext.includeSystemPrompt",
      replacement: "realtime.agentContext",
      message:
        "Remove realtime.agentContext.includeSystemPrompt; realtime context now uses the generated agent prompt.",
    });
  }

  return issues;
}

/** Formats legacy-config warnings with the exact doctor command operators should run. */
export function formatVoiceCallLegacyConfigWarnings(params: {
  /** Raw voice-call plugin config value to inspect. */
  value: unknown;
  /** Fully qualified config path shown in warning lines. */
  configPathPrefix: string;
  /** Exact command operators can run to rewrite legacy keys. */
  doctorFixCommand: string;
}): string[] {
  const issues = collectVoiceCallLegacyConfigIssues(params.value);
  if (issues.length === 0) {
    return [];
  }

  return [
    `[voice-call] legacy config keys detected under ${params.configPathPrefix}; runtime loading will not rewrite them, and support for the legacy shape will be removed in ${VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION}. Run "${params.doctorFixCommand}".`,
    ...issues.map(
      (issue) => `[voice-call] ${params.configPathPrefix}.${issue.path}: ${issue.message}`,
    ),
  ];
}

/** Migrates the retired voice-call config shape into the canonical schema input. */
export function migrateVoiceCallLegacyConfigInput(params: {
  /** Raw voice-call plugin config value before schema parsing. */
  value: unknown;
  /** Fully qualified config path used when reporting change lines. */
  configPathPrefix?: string;
}): {
  /** Canonical config-shaped object suitable for VoiceCallConfigSchema parsing. */
  config: Record<string, unknown>;
  /** Doctor-style change log describing every rewrite/removal applied. */
  changes: string[];
  /** Legacy issues detected before migration, for warnings and removal planning. */
  issues: VoiceCallLegacyConfigIssue[];
} {
  const raw = asObject(params.value) ?? {};
  const realtime = asObject(raw.realtime);
  const realtimeAgentContext = asObject(realtime?.agentContext);
  const twilio = asObject(raw.twilio);
  const streaming = asObject(raw.streaming);
  const configPathPrefix = params.configPathPrefix ?? "plugins.entries.voice-call.config";
  const issues = collectVoiceCallLegacyConfigIssues(raw);

  const legacyStreamingOpenAICompat: Record<string, unknown> = {};
  const streamingOpenAIApiKey = getString(streaming, "openaiApiKey");
  if (streamingOpenAIApiKey) {
    legacyStreamingOpenAICompat.apiKey = streamingOpenAIApiKey;
  }
  const streamingSttModel = getString(streaming, "sttModel");
  if (streamingSttModel) {
    legacyStreamingOpenAICompat.model = streamingSttModel;
  }
  const streamingSilenceDurationMs = getNumber(streaming, "silenceDurationMs");
  if (streamingSilenceDurationMs !== undefined) {
    legacyStreamingOpenAICompat.silenceDurationMs = streamingSilenceDurationMs;
  }
  const streamingVadThreshold = getNumber(streaming, "vadThreshold");
  if (streamingVadThreshold !== undefined) {
    legacyStreamingOpenAICompat.vadThreshold = streamingVadThreshold;
  }
  const streamingProvider = getString(streaming, "provider");
  const legacyStreamingProvider = getString(streaming, "sttProvider");

  const normalizedStreaming: Record<string, unknown> | undefined = streaming
    ? {
        ...streaming,
        provider: streamingProvider ?? legacyStreamingProvider,
        // Legacy top-level STT knobs now live under the OpenAI streaming provider config.
        providers: mergeProviderConfig(streaming.providers, "openai", legacyStreamingOpenAICompat),
      }
    : undefined;

  if (normalizedStreaming) {
    delete normalizedStreaming.sttProvider;
    delete normalizedStreaming.openaiApiKey;
    delete normalizedStreaming.sttModel;
    delete normalizedStreaming.silenceDurationMs;
    delete normalizedStreaming.vadThreshold;
  }

  const normalizedTwilio = twilio
    ? {
        ...twilio,
      }
    : undefined;
  if (normalizedTwilio) {
    delete normalizedTwilio.from;
  }

  const normalizedRealtimeAgentContext = realtimeAgentContext
    ? {
        ...realtimeAgentContext,
      }
    : undefined;
  if (normalizedRealtimeAgentContext) {
    delete normalizedRealtimeAgentContext.includeSystemPrompt;
  }

  const normalizedRealtime = realtime
    ? {
        ...realtime,
        agentContext: normalizedRealtimeAgentContext ?? realtime.agentContext,
      }
    : undefined;

  const config = {
    ...raw,
    provider: raw.provider === "log" ? "mock" : raw.provider,
    fromNumber: raw.fromNumber ?? (typeof twilio?.from === "string" ? twilio.from : undefined),
    twilio: normalizedTwilio,
    streaming: normalizedStreaming,
    realtime: normalizedRealtime,
  };

  const changes: string[] = [];
  if (raw.provider === "log") {
    changes.push(`Moved ${configPathPrefix}.provider "log" → "mock".`);
  }
  if (typeof twilio?.from === "string" && typeof raw.fromNumber !== "string") {
    changes.push(`Moved ${configPathPrefix}.twilio.from → ${configPathPrefix}.fromNumber.`);
  }
  if (typeof streaming?.sttProvider === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.sttProvider → ${configPathPrefix}.streaming.provider.`,
    );
  }
  if (typeof streaming?.openaiApiKey === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.openaiApiKey → ${configPathPrefix}.streaming.providers.openai.apiKey.`,
    );
  }
  if (typeof streaming?.sttModel === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.sttModel → ${configPathPrefix}.streaming.providers.openai.model.`,
    );
  }
  if (getNumber(streaming, "silenceDurationMs") !== undefined) {
    changes.push(
      `Moved ${configPathPrefix}.streaming.silenceDurationMs → ${configPathPrefix}.streaming.providers.openai.silenceDurationMs.`,
    );
  } else if (typeof streaming?.silenceDurationMs === "number") {
    changes.push(`Removed invalid ${configPathPrefix}.streaming.silenceDurationMs.`);
  }
  if (getNumber(streaming, "vadThreshold") !== undefined) {
    changes.push(
      `Moved ${configPathPrefix}.streaming.vadThreshold → ${configPathPrefix}.streaming.providers.openai.vadThreshold.`,
    );
  } else if (typeof streaming?.vadThreshold === "number") {
    changes.push(`Removed invalid ${configPathPrefix}.streaming.vadThreshold.`);
  }
  if (realtimeAgentContext && Object.hasOwn(realtimeAgentContext, "includeSystemPrompt")) {
    changes.push(`Removed ${configPathPrefix}.realtime.agentContext.includeSystemPrompt.`);
  }

  return { config, changes, issues };
}

/** Returns only the migrated config object for callers that do not need issue/change details. */
export function normalizeVoiceCallLegacyConfigInput(value: unknown): Record<string, unknown> {
  return migrateVoiceCallLegacyConfigInput({ value }).config;
}

/** Parses voice-call plugin config after applying the bounded legacy migration. */
export function parseVoiceCallPluginConfig(value: unknown): VoiceCallConfig {
  return VoiceCallConfigSchema.parse(normalizeVoiceCallLegacyConfigInput(value));
}
