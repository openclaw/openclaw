import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { normalizeChannelId, type ChannelId } from "openclaw/plugin-sdk/channel-runtime";
import type {
  OpenClawConfig,
  TtsAutoMode,
  TtsConfig,
  TtsMode,
  TtsModelOverrideConfig,
  TtsProvider,
  CliTtsProviderConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import { CONFIG_DIR, resolveUserPath, stripMarkdown } from "openclaw/plugin-sdk/text-runtime";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
  normalizeTtsAutoMode,
  parseTtsDirectives,
  scheduleCleanup,
  summarizeText,
  type SpeechModelOverridePolicy,
  type SpeechProviderConfig,
  type SpeechVoiceOption,
  type TtsDirectiveOverrides,
  type TtsDirectiveParseResult,
} from "../api.js";

export type { TtsDirectiveOverrides, TtsDirectiveParseResult };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4096;

export type ResolvedTtsConfig = {
  auto: TtsAutoMode;
  mode: TtsMode;
  provider: TtsProvider;
  providerSource: "config" | "default";
  summaryModel?: string;
  modelOverrides: ResolvedTtsModelOverrides;
  providerConfigs: Record<string, SpeechProviderConfig>;
  prefsPath?: string;
  maxTextLength: number;
  timeoutMs: number;
};

type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    maxLength?: number;
    summarize?: boolean;
  };
};

export type ResolvedTtsModelOverrides = SpeechModelOverridePolicy;

export type TtsResult = {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  voiceCompatible?: boolean;
};

export type TtsSynthesisResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
};

export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  sampleRate?: number;
};

type TtsStatusEntry = {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  latencyMs?: number;
  error?: string;
};

let lastTtsAttempt: TtsStatusEntry | undefined;

function resolveModelOverridePolicy(
  overrides: TtsModelOverrideConfig | undefined,
): ResolvedTtsModelOverrides {
  const enabled = overrides?.enabled ?? true;
  if (!enabled) {
    return {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    };
  }
  const allow = (value: boolean | undefined, defaultValue = true) => value ?? defaultValue;
  return {
    enabled: true,
    allowText: allow(overrides?.allowText),
    allowProvider: allow(overrides?.allowProvider, false),
    allowVoice: allow(overrides?.allowVoice),
    allowModelId: allow(overrides?.allowModelId),
    allowVoiceSettings: allow(overrides?.allowVoiceSettings),
    allowNormalization: allow(overrides?.allowNormalization),
    allowSeed: allow(overrides?.allowSeed),
  };
}

function sortSpeechProvidersForAutoSelection(cfg?: OpenClawConfig) {
  return listSpeechProviders(cfg).toSorted((left, right) => {
    const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function resolveRegistryDefaultSpeechProviderId(cfg?: OpenClawConfig): TtsProvider {
  return sortSpeechProvidersForAutoSelection(cfg)[0]?.id ?? "";
}

function asProviderConfig(value: unknown): SpeechProviderConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SpeechProviderConfig)
    : {};
}

function asProviderConfigMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeCliAgentConfig(
  baseConfig: CliTtsProviderConfig,
  agentId?: string,
): CliTtsProviderConfig {
  if (!agentId || !baseConfig.agents?.[agentId]) {
    return baseConfig;
  }
  const agentConfig = baseConfig.agents[agentId];
  // Merge agent-specific overrides on top of base config
  // Agent config fields override base config fields (except 'agents' and 'command' if not specified)
  return {
    ...baseConfig,
    ...agentConfig,
    // Keep the agents map from base (not overwritten by agent config)
    agents: baseConfig.agents,
    // Use base command if agent doesn't specify one
    command: agentConfig.command ?? baseConfig.command,
  };
}

function resolveSpeechProviderConfigs(
  raw: TtsConfig,
  cfg: OpenClawConfig,
  timeoutMs: number,
  agentId?: string,
): Record<string, SpeechProviderConfig> {
  const providerConfigs: Record<string, SpeechProviderConfig> = {};
  const rawProviders = asProviderConfigMap(raw.providers);
  for (const provider of listSpeechProviders(cfg)) {
    let rawConfig = asProviderConfig(
      rawProviders[provider.id] ?? (raw as Record<string, unknown>)[provider.id],
    );

    // Merge CLI agent-specific config if this is the CLI provider
    if (provider.id === "cli" && agentId) {
      const cliConfig = rawConfig as CliTtsProviderConfig;
      if (cliConfig.agents?.[agentId]) {
        rawConfig = mergeCliAgentConfig(cliConfig, agentId);
      }
    }

    providerConfigs[provider.id] =
      provider.resolveConfig?.({
        cfg,
        rawConfig: {
          ...(raw as Record<string, unknown>),
          providers: rawProviders,
        },
        timeoutMs,
      }) ?? rawConfig;
  }
  return providerConfigs;
}

export function getResolvedSpeechProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
): SpeechProviderConfig {
  const canonical =
    canonicalizeSpeechProviderId(providerId, cfg) ?? providerId.trim().toLowerCase();
  return config.providerConfigs[canonical] ?? {};
}

export function resolveTtsConfig(cfg: OpenClawConfig, agentId?: string): ResolvedTtsConfig {
  const raw: TtsConfig = cfg.messages?.tts ?? {};
  const providerSource = raw.provider ? "config" : "default";
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auto = normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
  return {
    auto,
    mode: raw.mode ?? "final",
    provider:
      canonicalizeSpeechProviderId(raw.provider, cfg) ??
      resolveRegistryDefaultSpeechProviderId(cfg),
    providerSource,
    summaryModel: raw.summaryModel?.trim() || undefined,
    modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
    providerConfigs: resolveSpeechProviderConfigs(raw, cfg, timeoutMs, agentId),
    prefsPath: raw.prefsPath,
    maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    timeoutMs,
  };
}

export function resolveTtsPrefsPath(config: ResolvedTtsConfig): string {
  if (config.prefsPath?.trim()) {
    return resolveUserPath(config.prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(CONFIG_DIR, "settings", "tts.json");
}

function resolveTtsAutoModeFromPrefs(prefs: TtsUserPrefs): TtsAutoMode | undefined {
  const auto = normalizeTtsAutoMode(prefs.tts?.auto);
  if (auto) {
    return auto;
  }
  if (typeof prefs.tts?.enabled === "boolean") {
    return prefs.tts.enabled ? "always" : "off";
  }
  return undefined;
}

export function resolveTtsAutoMode(params: {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
}): TtsAutoMode {
  const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return sessionAuto;
  }
  const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(params.prefsPath));
  if (prefsAuto) {
    return prefsAuto;
  }
  return params.config.auto;
}

export function buildTtsSystemPromptHint(cfg: OpenClawConfig): string | undefined {
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({ config, prefsPath });
  if (autoMode === "off") {
    return undefined;
  }
  const maxLength = getTtsMaxLength(prefsPath);
  const summarize = isSummarizationEnabled(prefsPath) ? "on" : "off";
  const autoHint =
    autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : autoMode === "tagged"
        ? "Only use TTS when you include [[tts]] or [[tts:text]] tags."
        : undefined;
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    `Keep spoken text ≤${maxLength} chars to avoid auto-summary (summary ${summarize}).`,
    "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}

function readPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(readFileSync(prefsPath, "utf8")) as TtsUserPrefs;
  } catch {
    return {};
  }
}

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function updatePrefs(prefsPath: string, update: (prefs: TtsUserPrefs) => void): void {
  const prefs = readPrefs(prefsPath);
  update(prefs);
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

export function isTtsEnabled(
  config: ResolvedTtsConfig,
  prefsPath: string,
  sessionAuto?: string,
): boolean {
  return resolveTtsAutoMode({ config, prefsPath, sessionAuto }) !== "off";
}

export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updatePrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    delete next.enabled;
    next.auto = mode;
    prefs.tts = next;
  });
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function getTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider {
  const prefs = readPrefs(prefsPath);
  const prefsProvider = canonicalizeSpeechProviderId(prefs.tts?.provider);
  if (prefsProvider) {
    return prefsProvider;
  }
  if (config.providerSource === "config") {
    return canonicalizeSpeechProviderId(config.provider) ?? config.provider;
  }

  for (const provider of sortSpeechProvidersForAutoSelection()) {
    if (
      provider.isConfigured({
        providerConfig: config.providerConfigs[provider.id] ?? {},
        timeoutMs: config.timeoutMs,
      })
    ) {
      return provider.id;
    }
  }
  return config.provider;
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider: canonicalizeSpeechProviderId(provider) ?? provider };
  });
}

export function getTtsMaxLength(prefsPath: string): number {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function isSummarizationEnabled(prefsPath: string): boolean {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return lastTtsAttempt;
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  lastTtsAttempt = entry;
}

const OPUS_CHANNELS = new Set(["telegram", "feishu", "whatsapp", "matrix"]);

function resolveChannelId(channel: string | undefined): ChannelId | null {
  return channel ? normalizeChannelId(channel) : null;
}

export function resolveTtsProviderOrder(primary: TtsProvider, cfg?: OpenClawConfig): TtsProvider[] {
  const normalizedPrimary = canonicalizeSpeechProviderId(primary, cfg) ?? primary;
  const ordered = new Set<TtsProvider>([normalizedPrimary]);
  for (const provider of sortSpeechProvidersForAutoSelection(cfg)) {
    const normalized = provider.id;
    if (normalized !== normalizedPrimary) {
      ordered.add(normalized);
    }
  }
  return [...ordered];
}

export function isTtsProviderConfigured(
  config: ResolvedTtsConfig,
  provider: TtsProvider,
  cfg?: OpenClawConfig,
): boolean {
  const resolvedProvider = getSpeechProvider(provider, cfg);
  if (!resolvedProvider) {
    return false;
  }
  return (
    resolvedProvider.isConfigured({
      cfg,
      providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, cfg),
      timeoutMs: config.timeoutMs,
    }) ?? false
  );
}

function formatTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${error.message}`;
}

function buildTtsFailureResult(errors: string[]): { success: false; error: string } {
  return {
    success: false,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
  };
}

function resolveReadySpeechProvider(params: {
  provider: TtsProvider;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  errors: string[];
  requireTelephony?: boolean;
}): NonNullable<ReturnType<typeof getSpeechProvider>> | null {
  const resolvedProvider = getSpeechProvider(params.provider, params.cfg);
  if (!resolvedProvider) {
    params.errors.push(`${params.provider}: no provider registered`);
    return null;
  }
  const providerConfig = getResolvedSpeechProviderConfig(
    params.config,
    resolvedProvider.id,
    params.cfg,
  );
  if (
    !resolvedProvider.isConfigured({
      cfg: params.cfg,
      providerConfig,
      timeoutMs: params.config.timeoutMs,
    })
  ) {
    params.errors.push(`${params.provider}: not configured`);
    return null;
  }
  if (params.requireTelephony && !resolvedProvider.synthesizeTelephony) {
    params.errors.push(`${params.provider}: unsupported for telephony`);
    return null;
  }
  return resolvedProvider;
}

function resolveTtsRequestSetup(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  providerOverride?: TtsProvider;
  disableFallback?: boolean;
  agentId?: string;
}):
  | {
      config: ResolvedTtsConfig;
      providers: TtsProvider[];
    }
  | {
      error: string;
    } {
  const config = resolveTtsConfig(params.cfg, params.agentId);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  if (params.text.length > config.maxTextLength) {
    return {
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = getTtsProvider(config, prefsPath);
  const provider =
    canonicalizeSpeechProviderId(params.providerOverride, params.cfg) ?? userProvider;
  return {
    config,
    providers: params.disableFallback ? [provider] : resolveTtsProviderOrder(provider, params.cfg),
  };
}

export async function textToSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  agentId?: string;
}): Promise<TtsResult> {
  const synthesis = await synthesizeSpeech(params);
  if (!synthesis.success || !synthesis.audioBuffer || !synthesis.fileExtension) {
    return buildTtsFailureResult([synthesis.error ?? "TTS conversion failed"]);
  }

  const tempRoot = resolvePreferredOpenClawTmpDir();
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
  const audioPath = path.join(tempDir, `voice-${Date.now()}${synthesis.fileExtension}`);
  writeFileSync(audioPath, synthesis.audioBuffer);
  scheduleCleanup(tempDir);

  return {
    success: true,
    audioPath,
    latencyMs: synthesis.latencyMs,
    provider: synthesis.provider,
    outputFormat: synthesis.outputFormat,
    voiceCompatible: synthesis.voiceCompatible,
  };
}

export async function synthesizeSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  agentId?: string;
}): Promise<TtsSynthesisResult> {
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    disableFallback: params.disableFallback,
    agentId: params.agentId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { config, providers } = setup;
  const channelId = resolveChannelId(params.channel);
  const target = channelId && OPUS_CHANNELS.has(channelId) ? "voice-note" : "audio-file";

  const errors: string[] = [];

  for (const provider of providers) {
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg: params.cfg,
        config,
        errors,
      });
      if (!resolvedProvider) {
        continue;
      }
      const synthesis = await resolvedProvider.synthesize({
        text: params.text,
        cfg: params.cfg,
        providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, params.cfg),
        target,
        providerOverrides: params.overrides?.providerOverrides?.[resolvedProvider.id],
        timeoutMs: config.timeoutMs,
      });
      return {
        success: true,
        audioBuffer: synthesis.audioBuffer,
        latencyMs: Date.now() - providerStart,
        provider,
        outputFormat: synthesis.outputFormat,
        voiceCompatible: synthesis.voiceCompatible,
        fileExtension: synthesis.fileExtension,
      };
    } catch (err) {
      errors.push(formatTtsProviderError(provider, err));
    }
  }

  return buildTtsFailureResult(errors);
}

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  agentId?: string;
}): Promise<TtsTelephonyResult> {
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    agentId: params.agentId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { config, providers } = setup;
  const errors: string[] = [];

  for (const provider of providers) {
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg: params.cfg,
        config,
        errors,
        requireTelephony: true,
      });
      if (!resolvedProvider?.synthesizeTelephony) {
        continue;
      }
      const synthesis = await resolvedProvider.synthesizeTelephony({
        text: params.text,
        cfg: params.cfg,
        providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, params.cfg),
        timeoutMs: config.timeoutMs,
      });

      return {
        success: true,
        audioBuffer: synthesis.audioBuffer,
        latencyMs: Date.now() - providerStart,
        provider,
        outputFormat: synthesis.outputFormat,
        sampleRate: synthesis.sampleRate,
      };
    } catch (err) {
      errors.push(formatTtsProviderError(provider, err));
    }
  }

  return buildTtsFailureResult(errors);
}

export async function listSpeechVoices(params: {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const provider = canonicalizeSpeechProviderId(params.provider, params.cfg);
  if (!provider) {
    throw new Error("speech provider id is required");
  }
  const config = params.config ?? (params.cfg ? resolveTtsConfig(params.cfg) : undefined);
  if (!config) {
    throw new Error(`speech provider ${provider} requires cfg or resolved config`);
  }
  const resolvedProvider = getSpeechProvider(provider, params.cfg);
  if (!resolvedProvider) {
    throw new Error(`speech provider ${provider} is not registered`);
  }
  if (!resolvedProvider.listVoices) {
    throw new Error(`speech provider ${provider} does not support voice listing`);
  }
  return await resolvedProvider.listVoices({
    cfg: params.cfg,
    providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, params.cfg),
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
  });
}

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
  agentId?: string;
}): Promise<ReplyPayload> {
  if (params.payload.isCompactionNotice) {
    return params.payload;
  }
  const config = resolveTtsConfig(params.cfg, params.agentId);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({
    config,
    prefsPath,
    sessionAuto: params.ttsAuto,
  });
  if (autoMode === "off") {
    return params.payload;
  }

  const reply = resolveSendableOutboundReplyParts(params.payload);
  const text = reply.text;
  const directives = parseTtsDirectives(text, config.modelOverrides, {
    cfg: params.cfg,
    providerConfigs: config.providerConfigs,
  });
  if (directives.warnings.length > 0) {
    logVerbose(`TTS: ignored directive overrides (${directives.warnings.join("; ")})`);
  }

  const cleanedText = directives.cleanedText;
  const trimmedCleaned = cleanedText.trim();
  const visibleText = trimmedCleaned.length > 0 ? trimmedCleaned : "";
  const ttsText = directives.ttsText?.trim() || visibleText;

  const nextPayload =
    visibleText === text.trim()
      ? params.payload
      : {
          ...params.payload,
          text: visibleText.length > 0 ? visibleText : undefined,
        };

  if (autoMode === "tagged" && !directives.hasDirective) {
    return nextPayload;
  }
  if (autoMode === "inbound" && params.inboundAudio !== true) {
    return nextPayload;
  }

  const mode = config.mode ?? "final";
  if (mode === "final" && params.kind && params.kind !== "final") {
    return nextPayload;
  }

  if (!ttsText.trim()) {
    return nextPayload;
  }
  if (reply.hasMedia) {
    return nextPayload;
  }
  if (text.includes("MEDIA:")) {
    return nextPayload;
  }
  if (ttsText.trim().length < 10) {
    return nextPayload;
  }

  const maxLength = getTtsMaxLength(prefsPath);
  let textForAudio = ttsText.trim();
  let wasSummarized = false;

  if (textForAudio.length > maxLength) {
    if (!isSummarizationEnabled(prefsPath)) {
      logVerbose(
        `TTS: truncating long text (${textForAudio.length} > ${maxLength}), summarization disabled.`,
      );
      textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
    } else {
      try {
        const summary = await summarizeText({
          text: textForAudio,
          targetLength: maxLength,
          cfg: params.cfg,
          config,
          timeoutMs: config.timeoutMs,
        });
        textForAudio = summary.summary;
        wasSummarized = true;
        if (textForAudio.length > config.maxTextLength) {
          logVerbose(
            `TTS: summary exceeded hard limit (${textForAudio.length} > ${config.maxTextLength}); truncating.`,
          );
          textForAudio = `${textForAudio.slice(0, config.maxTextLength - 3)}...`;
        }
      } catch (err) {
        const error = err as Error;
        logVerbose(`TTS: summarization failed, truncating instead: ${error.message}`);
        textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
      }
    }
  }

  textForAudio = stripMarkdown(textForAudio).trim();
  if (textForAudio.length < 10) {
    return nextPayload;
  }

  const ttsStart = Date.now();
  const result = await textToSpeech({
    text: textForAudio,
    cfg: params.cfg,
    prefsPath,
    channel: params.channel,
    overrides: directives.overrides,
  });

  if (result.success && result.audioPath) {
    lastTtsAttempt = {
      timestamp: Date.now(),
      success: true,
      textLength: text.length,
      summarized: wasSummarized,
      provider: result.provider,
      latencyMs: result.latencyMs,
    };

    const channelId = resolveChannelId(params.channel);
    const shouldVoice =
      channelId !== null && OPUS_CHANNELS.has(channelId) && result.voiceCompatible === true;
    return {
      ...nextPayload,
      mediaUrl: result.audioPath,
      audioAsVoice: shouldVoice || params.payload.audioAsVoice,
    };
  }

  lastTtsAttempt = {
    timestamp: Date.now(),
    success: false,
    textLength: text.length,
    summarized: wasSummarized,
    error: result.error,
  };

  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms (${result.error ?? "unknown"}).`);
  return nextPayload;
}

export const _test = {
  parseTtsDirectives,
  resolveModelOverridePolicy,
  summarizeText,
  getResolvedSpeechProviderConfig,
};
