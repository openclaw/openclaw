import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  OpenClawConfig,
  TelegramInlineButtonsScope,
} from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

export const SPEAKEASY_VOICE_CALLBACK_PREFIX = "tts:speakeasy:";
export const SPEAKEASY_VOICE_BUTTON_LABEL = "🔊 Voice note";
const MIN_SPEAKEASY_TEXT_CHARS = 20;
const SPEAKEASY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SPEAKEASY_GENERATION_COUNTER_TTL_MS = 48 * 60 * 60 * 1000;
const SPEAKEASY_DAILY_GENERATION_CAP = 50;
const SPEAKEASY_TTS_TIMEOUT_MS = 120_000;
const SPEAKEASY_TTS_MAX_OUTPUT_CHARS = 1024 * 1024;
const SPEAKEASY_VOICE_NOTE_EXTENSIONS = new Set([".oga", ".ogg", ".opus", ".mp3", ".m4a"]);
const TELEGRAM_MAX_INLINE_BUTTON_ACTIONS = 100;
const SPEAKEASY_STATE_NAMESPACE = "telegram.speakeasy-voice";
const SPEAKEASY_STATE_MAX_ENTRIES = 8_192;
const SPEAKEASY_STDIN_ARGV_WRAPPER = [
  "import os, runpy, sys",
  "script = sys.argv[1]",
  "text = sys.stdin.read()",
  "sys.path.insert(0, os.path.dirname(script))",
  "sys.argv = [script, text]",
  "runpy.run_path(script, run_name='__main__')",
].join("\n");

type ReplyLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  channelData?: { telegram?: { buttons?: TelegramInlineButtons } };
};

export type SpeakeasyVoiceCache = {
  version: 1;
  entries: Record<string, { chatId: string; text: string; createdAt: number }>;
  generations: Record<string, { date: string; count: number }>;
};

export type SpeakeasyVoiceStateRecord =
  | { kind: "entry"; scopeKey: string; chatId: string; text: string; createdAt: number }
  | { kind: "generation"; scopeKey: string; chatId: string; date: string; count: number };

type SpeakeasyVoiceStateStore = PluginStateSyncKeyedStore<SpeakeasyVoiceStateRecord>;

type SpeakeasyChatsConfig = {
  enabled?: string[];
};

function isSpeakeasyInlineButtonScopeAllowed(params: {
  inlineButtonsScope?: TelegramInlineButtonsScope;
  isGroup?: boolean;
}): boolean {
  const scope = params.inlineButtonsScope ?? "allowlist";
  if (scope === "off") {
    return false;
  }
  if (scope === "dm" && params.isGroup) {
    return false;
  }
  if (scope === "group" && !params.isGroup) {
    return false;
  }
  return true;
}

function resolveConfiguredWorkspace(cfg: OpenClawConfig): string | undefined {
  const workspace = cfg.agents?.defaults?.workspace;
  return typeof workspace === "string" && workspace.trim() ? workspace.trim() : undefined;
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export function resolveSpeakeasyWorkspaceDir(cfg: OpenClawConfig): string {
  const candidates = [
    process.env.OPENCLAW_SPEAKEASY_WORKSPACE_DIR,
    process.env.OPENCLAW_WORKSPACE_DIR,
    resolveConfiguredWorkspace(cfg),
    process.cwd(),
    path.join(homedir(), ".openclaw", "workspace"),
  ];
  for (const candidate of candidates) {
    if (!candidate?.trim()) {
      continue;
    }
    const resolved = path.resolve(expandHomePath(candidate));
    if (existsSync(path.join(resolved, "config", "speakeasy-chats.json"))) {
      return resolved;
    }
  }
  return path.join(homedir(), ".openclaw", "workspace");
}

function resolveSpeakeasyConfigPath(cfg: OpenClawConfig): string {
  return path.join(resolveSpeakeasyWorkspaceDir(cfg), "config", "speakeasy-chats.json");
}

function resolveSpeakeasyGeneratedAudioDir(cfg: OpenClawConfig): string {
  return path.join(resolveSpeakeasyWorkspaceDir(cfg), "state", "speakeasy", "generated");
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function emptySpeakeasyCache(): SpeakeasyVoiceCache {
  return { version: 1, entries: {}, generations: {} };
}

function pruneSpeakeasyCache(cache: SpeakeasyVoiceCache, now = Date.now()): void {
  for (const [id, entry] of Object.entries(cache.entries)) {
    if (now - entry.createdAt > SPEAKEASY_CACHE_TTL_MS) {
      delete cache.entries[id];
    }
  }
  const currentDay = todayKey(new Date(now));
  for (const [id, generation] of Object.entries(cache.generations)) {
    if (generation.date !== currentDay) {
      delete cache.generations[id];
    }
  }
}

function resolveSpeakeasyStateScopeKey(cfg: OpenClawConfig): string {
  return createHash("sha256")
    .update(resolveSpeakeasyWorkspaceDir(cfg), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function speakeasyStateKeyPrefix(scopeKey: string): string {
  return `${scopeKey}:`;
}

function speakeasyEntryStateKey(scopeKey: string, id: string): string {
  return `${speakeasyStateKeyPrefix(scopeKey)}entry:${id}`;
}

function speakeasyGenerationStateKey(params: {
  scopeKey: string;
  chatId: string;
  date: string;
}): string {
  return `${speakeasyStateKeyPrefix(params.scopeKey)}generation:${params.chatId}:${params.date}`;
}

export function loadSpeakeasyCache(cfg: OpenClawConfig): SpeakeasyVoiceCache {
  const scopeKey = resolveSpeakeasyStateScopeKey(cfg);
  const keyPrefix = speakeasyStateKeyPrefix(scopeKey);
  const store = openSpeakeasyStateStore();
  const normalized = emptySpeakeasyCache();
  for (const { key, value } of store.entries()) {
    if (!key.startsWith(keyPrefix) || value.scopeKey !== scopeKey) {
      continue;
    }
    if (value.kind === "entry" && key.startsWith(`${keyPrefix}entry:`)) {
      normalized.entries[key.slice(`${keyPrefix}entry:`.length)] = {
        chatId: value.chatId,
        text: value.text,
        createdAt: value.createdAt,
      };
      continue;
    }
    if (value.kind === "generation" && key.startsWith(`${keyPrefix}generation:`)) {
      normalized.generations[key.slice(`${keyPrefix}generation:`.length)] = {
        date: value.date,
        count: value.count,
      };
    }
  }
  pruneSpeakeasyCache(normalized);
  for (const { key, value } of store.entries()) {
    if (!key.startsWith(keyPrefix) || value.scopeKey !== scopeKey) {
      continue;
    }
    if (value.kind === "entry" && normalized.entries[key.slice(`${keyPrefix}entry:`.length)]) {
      continue;
    }
    if (
      value.kind === "generation" &&
      normalized.generations[key.slice(`${keyPrefix}generation:`.length)]
    ) {
      continue;
    }
    store.delete(key);
  }
  return normalized;
}

export function writeSpeakeasyCache(cfg: OpenClawConfig, cache: SpeakeasyVoiceCache): void {
  const scopeKey = resolveSpeakeasyStateScopeKey(cfg);
  const keyPrefix = speakeasyStateKeyPrefix(scopeKey);
  const store = openSpeakeasyStateStore();
  for (const { key } of store.entries()) {
    if (key.startsWith(keyPrefix)) {
      store.delete(key);
    }
  }
  for (const [id, entry] of Object.entries(cache.entries)) {
    store.register(
      speakeasyEntryStateKey(scopeKey, id),
      { kind: "entry", scopeKey, ...entry },
      { ttlMs: Math.max(1, SPEAKEASY_CACHE_TTL_MS - (Date.now() - entry.createdAt)) },
    );
  }
  for (const [key, generation] of Object.entries(cache.generations)) {
    const [chatId, date] = key.split(":", 2);
    if (!chatId || !date) {
      continue;
    }
    store.register(
      speakeasyGenerationStateKey({ scopeKey, chatId, date }),
      {
        kind: "generation",
        scopeKey,
        chatId,
        ...generation,
      },
      { ttlMs: SPEAKEASY_GENERATION_COUNTER_TTL_MS },
    );
  }
}

function loadSpeakeasyChatsConfig(cfg: OpenClawConfig): SpeakeasyChatsConfig {
  return readJsonFile<SpeakeasyChatsConfig>(resolveSpeakeasyConfigPath(cfg), {});
}

export function isSpeakeasyChatEnabled(params: { cfg: OpenClawConfig; chatId: string }): boolean {
  return (loadSpeakeasyChatsConfig(params.cfg).enabled ?? []).includes(`telegram:${params.chatId}`);
}

export function isSpeakeasyVoiceCallbackData(data: string): boolean {
  return data.startsWith(SPEAKEASY_VOICE_CALLBACK_PREFIX);
}

function parseSpeakeasyVoiceCallbackId(data: string): string | null {
  if (!isSpeakeasyVoiceCallbackData(data)) {
    return null;
  }
  const id = data.slice(SPEAKEASY_VOICE_CALLBACK_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function generationKey(chatId: string, now = new Date()): string {
  return `${chatId}:${todayKey(now)}`;
}

let speakeasyStateStoreForTest: SpeakeasyVoiceStateStore | undefined;

export function setSpeakeasyVoiceStateStoreForTest(
  store: SpeakeasyVoiceStateStore | undefined,
): void {
  speakeasyStateStoreForTest = store;
}

function openSpeakeasyStateStore(): SpeakeasyVoiceStateStore {
  const store =
    speakeasyStateStoreForTest ??
    getOptionalTelegramRuntime()?.state.openSyncKeyedStore<SpeakeasyVoiceStateRecord>({
      namespace: SPEAKEASY_STATE_NAMESPACE,
      maxEntries: SPEAKEASY_STATE_MAX_ENTRIES,
    });
  if (!store) {
    throw new Error("Telegram Speakeasy state store is unavailable");
  }
  return store;
}

function requireSpeakeasyStateUpdate(
  store: SpeakeasyVoiceStateStore,
): NonNullable<SpeakeasyVoiceStateStore["update"]> {
  if (typeof store.update !== "function") {
    throw new Error("Telegram Speakeasy state store does not support atomic updates");
  }
  return store.update.bind(store);
}

export function shouldAllowSpeakeasyVoiceGeneration(params: {
  cache: SpeakeasyVoiceCache;
  chatId: string;
  now?: Date;
}): boolean {
  const now = params.now ?? new Date();
  const record = params.cache.generations[generationKey(params.chatId, now)];
  return record?.date !== todayKey(now) || record.count < SPEAKEASY_DAILY_GENERATION_CAP;
}

export function markSpeakeasyVoiceGenerated(params: {
  cache: SpeakeasyVoiceCache;
  chatId: string;
  now?: Date;
}): void {
  const now = params.now ?? new Date();
  const key = generationKey(params.chatId, now);
  const current = params.cache.generations[key];
  params.cache.generations[key] = {
    date: todayKey(now),
    count: current?.date === todayKey(now) ? current.count + 1 : 1,
  };
}

export function resolveSpeakeasyCachedText(params: {
  cfg: OpenClawConfig;
  cache: SpeakeasyVoiceCache;
  data: string;
  chatId: string;
  now?: number;
}): { ok: true; text: string } | { ok: false; reason: "miss" | "expired" | "disabled" } {
  if (!isSpeakeasyChatEnabled({ cfg: params.cfg, chatId: params.chatId })) {
    return { ok: false, reason: "disabled" };
  }
  const id = parseSpeakeasyVoiceCallbackId(params.data);
  const entry = id ? params.cache.entries[id] : undefined;
  if (!id || !entry || entry.chatId !== params.chatId) {
    return { ok: false, reason: "miss" };
  }
  if ((params.now ?? Date.now()) - entry.createdAt > SPEAKEASY_CACHE_TTL_MS) {
    delete params.cache.entries[id];
    return { ok: false, reason: "expired" };
  }
  return { ok: true, text: entry.text };
}

function queueSpeakeasyCacheEntry(params: {
  cfg: OpenClawConfig;
  chatId: string;
  text: string;
}): string | null {
  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  const scopeKey = resolveSpeakeasyStateScopeKey(params.cfg);
  const entry = {
    scopeKey,
    chatId: params.chatId,
    text: params.text,
    createdAt: Date.now(),
  };
  try {
    openSpeakeasyStateStore().register(
      speakeasyEntryStateKey(scopeKey, id),
      {
        kind: "entry",
        ...entry,
      },
      { ttlMs: SPEAKEASY_CACHE_TTL_MS },
    );
  } catch {
    return null;
  }
  return id;
}

export async function flushSpeakeasyCacheWritesForTest(): Promise<void> {
  await Promise.resolve();
}

export function reserveSpeakeasyVoiceGeneration(params: {
  cfg: OpenClawConfig;
  data: string;
  chatId: string;
}): { ok: true; text: string } | { ok: false; reason: "miss" | "expired" | "disabled" | "limit" } {
  if (!isSpeakeasyChatEnabled({ cfg: params.cfg, chatId: params.chatId })) {
    return { ok: false, reason: "disabled" };
  }
  const id = parseSpeakeasyVoiceCallbackId(params.data);
  if (!id) {
    return { ok: false, reason: "miss" };
  }
  const scopeKey = resolveSpeakeasyStateScopeKey(params.cfg);
  const store = openSpeakeasyStateStore();
  const entry = store.lookup(speakeasyEntryStateKey(scopeKey, id));
  if (entry?.kind !== "entry" || entry.scopeKey !== scopeKey || entry.chatId !== params.chatId) {
    return { ok: false, reason: "miss" };
  }
  if (Date.now() - entry.createdAt > SPEAKEASY_CACHE_TTL_MS) {
    store.delete(speakeasyEntryStateKey(scopeKey, id));
    return { ok: false, reason: "expired" };
  }

  const today = todayKey();
  const generationStoreKey = speakeasyGenerationStateKey({
    scopeKey,
    chatId: params.chatId,
    date: today,
  });
  let limited = false;
  const updated = requireSpeakeasyStateUpdate(store)(
    generationStoreKey,
    (current) => {
      if (
        current?.kind === "generation" &&
        current.scopeKey === scopeKey &&
        current.chatId === params.chatId &&
        current.date === today
      ) {
        if (current.count >= SPEAKEASY_DAILY_GENERATION_CAP) {
          limited = true;
          return current;
        }
        return { ...current, count: current.count + 1 };
      }
      return { kind: "generation", scopeKey, chatId: params.chatId, date: today, count: 1 };
    },
    { ttlMs: SPEAKEASY_GENERATION_COUNTER_TTL_MS },
  );
  if (!updated) {
    throw new Error("Telegram Speakeasy state store did not reserve generation quota");
  }
  if (limited) {
    return { ok: false, reason: "limit" };
  }
  return { ok: true, text: entry.text };
}

export function releaseSpeakeasyVoiceGenerationReservation(params: {
  cfg: OpenClawConfig;
  chatId: string;
}): void {
  const scopeKey = resolveSpeakeasyStateScopeKey(params.cfg);
  const today = todayKey();
  const generationStoreKey = speakeasyGenerationStateKey({
    scopeKey,
    chatId: params.chatId,
    date: today,
  });
  const store = openSpeakeasyStateStore();
  const current = store.lookup(generationStoreKey);
  if (
    current?.kind !== "generation" ||
    current.scopeKey !== scopeKey ||
    current.chatId !== params.chatId ||
    current.date !== today
  ) {
    return;
  }
  if (current.count <= 1) {
    store.delete(generationStoreKey);
    return;
  }
  requireSpeakeasyStateUpdate(store)(
    generationStoreKey,
    (latest) => {
      if (
        latest?.kind !== "generation" ||
        latest.scopeKey !== scopeKey ||
        latest.chatId !== params.chatId ||
        latest.date !== today
      ) {
        return latest;
      }
      return { ...latest, count: Math.max(0, latest.count - 1) };
    },
    { ttlMs: SPEAKEASY_GENERATION_COUNTER_TTL_MS },
  );
}

function countTelegramInlineButtonActions(buttons: TelegramInlineButtons | undefined): number {
  return buttons?.reduce((sum, row) => sum + row.length, 0) ?? 0;
}

export function assertSpeakeasyVoiceNoteOutputPath(outputPath: string): void {
  const extension = path.extname(outputPath).toLowerCase();
  if (!SPEAKEASY_VOICE_NOTE_EXTENSIONS.has(extension)) {
    throw new Error(`Speakeasy TTS output is not a Telegram voice-note file: ${outputPath}`);
  }
}

export function prepareSpeakeasyGeneratedVoiceNoteOutput(params: {
  cfg: OpenClawConfig;
  outputPath: string;
}): string {
  assertSpeakeasyVoiceNoteOutputPath(params.outputPath);
  const generatedDir = resolveSpeakeasyGeneratedAudioDir(params.cfg);
  const relativeToGeneratedDir = path.relative(generatedDir, params.outputPath);
  if (!relativeToGeneratedDir.startsWith("..") && !path.isAbsolute(relativeToGeneratedDir)) {
    return params.outputPath;
  }
  mkdirSync(generatedDir, { recursive: true });
  const copiedPath = path.join(
    generatedDir,
    `${randomUUID().replace(/-/g, "")}${path.extname(params.outputPath).toLowerCase()}`,
  );
  copyFileSync(params.outputPath, copiedPath);
  return copiedPath;
}

export function shouldAttachSpeakeasyVoiceButton(params: {
  reply: ReplyLike;
  cfg?: OpenClawConfig;
  chatId?: string;
  isGroup?: boolean;
  hasMedia?: boolean;
  inlineButtonsScope?: TelegramInlineButtonsScope;
}): boolean {
  if (params.isGroup) {
    return false;
  }
  if (
    !isSpeakeasyInlineButtonScopeAllowed({
      inlineButtonsScope: params.inlineButtonsScope,
      isGroup: params.isGroup,
    })
  ) {
    return false;
  }
  const text = params.reply.text?.trim() ?? "";
  if (text.length <= MIN_SPEAKEASY_TEXT_CHARS) {
    return false;
  }
  if (params.hasMedia || params.reply.mediaUrl || (params.reply.mediaUrls?.length ?? 0) > 0) {
    return false;
  }
  if (params.reply.audioAsVoice) {
    return false;
  }
  if (
    params.reply.channelData?.telegram?.buttons?.some((row) =>
      row.some((button) => button.callback_data?.startsWith(SPEAKEASY_VOICE_CALLBACK_PREFIX)),
    )
  ) {
    return false;
  }
  if (
    countTelegramInlineButtonActions(params.reply.channelData?.telegram?.buttons) >=
    TELEGRAM_MAX_INLINE_BUTTON_ACTIONS
  ) {
    return false;
  }
  if (
    !params.chatId ||
    !params.cfg ||
    !isSpeakeasyChatEnabled({ cfg: params.cfg, chatId: params.chatId })
  ) {
    return false;
  }
  return true;
}

export function withSpeakeasyVoiceButton<T extends ReplyLike>(params: {
  reply: T;
  cfg?: OpenClawConfig;
  chatId?: string;
  isGroup?: boolean;
  hasMedia?: boolean;
  inlineButtonsScope?: TelegramInlineButtonsScope;
}): T {
  if (!shouldAttachSpeakeasyVoiceButton(params)) {
    return params.reply;
  }
  const id = queueSpeakeasyCacheEntry({
    cfg: params.cfg!,
    chatId: params.chatId!,
    text: params.reply.text!.trim(),
  });
  if (!id) {
    return params.reply;
  }
  return {
    ...params.reply,
    channelData: {
      ...params.reply.channelData,
      telegram: {
        ...params.reply.channelData?.telegram,
        buttons: [
          ...(params.reply.channelData?.telegram?.buttons ?? []),
          [
            {
              text: SPEAKEASY_VOICE_BUTTON_LABEL,
              callback_data: `${SPEAKEASY_VOICE_CALLBACK_PREFIX}${id}`,
            },
          ],
        ],
      },
    },
  };
}

export async function generateSpeakeasyVoiceNote(params: {
  cfg: OpenClawConfig;
  text: string;
}): Promise<string> {
  const workspaceDir = resolveSpeakeasyWorkspaceDir(params.cfg);
  const scriptPath = path.join(workspaceDir, "scripts", "tts_elevenlabs_v2.py");
  const stdout = await runSpeakeasyTtsScript({
    cwd: workspaceDir,
    scriptPath,
    text: params.text,
  });
  const rawOutputPath = stdout
    .trim()
    .split(/\r?\n/)
    .findLast((line) => line.trim().length > 0)
    ?.trim();
  if (!rawOutputPath) {
    throw new Error("Speakeasy TTS did not print an output path");
  }
  const outputPath = path.isAbsolute(rawOutputPath)
    ? rawOutputPath
    : path.resolve(workspaceDir, rawOutputPath);
  return prepareSpeakeasyGeneratedVoiceNoteOutput({ cfg: params.cfg, outputPath });
}

function runSpeakeasyTtsScript(params: {
  cwd: string;
  scriptPath: string;
  text: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const child = spawn("python3", ["-c", SPEAKEASY_STDIN_ARGV_WRAPPER, params.scriptPath], {
      cwd: params.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() =>
        reject(new Error(`Speakeasy TTS timed out after ${SPEAKEASY_TTS_TIMEOUT_MS}ms`)),
      );
    }, SPEAKEASY_TTS_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > SPEAKEASY_TTS_MAX_OUTPUT_CHARS) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > SPEAKEASY_TTS_MAX_OUTPUT_CHARS) {
        stderr = stderr.slice(0, SPEAKEASY_TTS_MAX_OUTPUT_CHARS);
        child.kill("SIGTERM");
      }
    });
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(
          new Error(
            `Speakeasy TTS failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}: ${stderr.trim()}`,
          ),
        );
      });
    });
    child.stdin.on("error", (err) => {
      child.kill("SIGTERM");
      settle(() => reject(err));
    });
    try {
      child.stdin.end(params.text);
    } catch (err) {
      child.kill("SIGTERM");
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
