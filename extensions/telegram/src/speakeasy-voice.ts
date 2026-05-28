import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramInlineButtons } from "./button-types.js";

const execFileAsync = promisify(execFile);

export const SPEAKEASY_VOICE_CALLBACK_PREFIX = "tts:speakeasy:";
export const SPEAKEASY_VOICE_BUTTON_LABEL = "🔊 Voice note";
const MIN_SPEAKEASY_TEXT_CHARS = 20;
const SPEAKEASY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SPEAKEASY_DAILY_GENERATION_CAP = 50;

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

type SpeakeasyChatsConfig = {
  enabled?: string[];
};

function resolveConfiguredWorkspace(cfg: OpenClawConfig): string | undefined {
  const workspace = cfg.agents?.defaults?.workspace;
  return typeof workspace === "string" && workspace.trim() ? workspace.trim() : undefined;
}

export function resolveSpeakeasyWorkspaceDir(cfg: OpenClawConfig): string {
  const candidates = [
    process.env.OPENCLAW_SPEAKEASY_WORKSPACE_DIR,
    process.env.OPENCLAW_WORKSPACE,
    resolveConfiguredWorkspace(cfg),
    process.cwd(),
    path.join(homedir(), ".openclaw", "workspace"),
  ];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const resolved = path.resolve(candidate);
    if (existsSync(path.join(resolved, "config", "speakeasy-chats.json"))) return resolved;
  }
  return path.join(homedir(), ".openclaw", "workspace");
}

function resolveSpeakeasyConfigPath(cfg: OpenClawConfig): string {
  return path.join(resolveSpeakeasyWorkspaceDir(cfg), "config", "speakeasy-chats.json");
}

function resolveSpeakeasyCachePath(cfg: OpenClawConfig): string {
  return path.join(resolveSpeakeasyWorkspaceDir(cfg), "state", "speakeasy-cache.json");
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
    if (now - entry.createdAt > SPEAKEASY_CACHE_TTL_MS) delete cache.entries[id];
  }
}

export function loadSpeakeasyCache(cfg: OpenClawConfig): SpeakeasyVoiceCache {
  const cache = readJsonFile<SpeakeasyVoiceCache>(
    resolveSpeakeasyCachePath(cfg),
    emptySpeakeasyCache(),
  );
  const normalized: SpeakeasyVoiceCache = {
    version: 1,
    entries: cache.entries && typeof cache.entries === "object" ? cache.entries : {},
    generations:
      cache.generations && typeof cache.generations === "object" ? cache.generations : {},
  };
  pruneSpeakeasyCache(normalized);
  return normalized;
}

export function writeSpeakeasyCache(cfg: OpenClawConfig, cache: SpeakeasyVoiceCache): void {
  const cachePath = resolveSpeakeasyCachePath(cfg);
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
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
  if (!isSpeakeasyVoiceCallbackData(data)) return null;
  const id = data.slice(SPEAKEASY_VOICE_CALLBACK_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function generationKey(chatId: string, now = new Date()): string {
  return `${chatId}:${todayKey(now)}`;
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
  if (!id || !entry || entry.chatId !== params.chatId) return { ok: false, reason: "miss" };
  if ((params.now ?? Date.now()) - entry.createdAt > SPEAKEASY_CACHE_TTL_MS) {
    delete params.cache.entries[id];
    return { ok: false, reason: "expired" };
  }
  return { ok: true, text: entry.text };
}

function createSpeakeasyCacheEntry(params: {
  cfg: OpenClawConfig;
  chatId: string;
  text: string;
}): string {
  const cache = loadSpeakeasyCache(params.cfg);
  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  cache.entries[id] = {
    chatId: params.chatId,
    text: params.text,
    createdAt: Date.now(),
  };
  writeSpeakeasyCache(params.cfg, cache);
  return id;
}

export function shouldAttachSpeakeasyVoiceButton(params: {
  reply: ReplyLike;
  cfg?: OpenClawConfig;
  chatId?: string;
  isGroup?: boolean;
  hasMedia?: boolean;
}): boolean {
  if (params.isGroup) return false;
  if (
    !params.chatId ||
    !params.cfg ||
    !isSpeakeasyChatEnabled({ cfg: params.cfg, chatId: params.chatId })
  ) {
    return false;
  }
  const text = params.reply.text?.trim() ?? "";
  if (text.length <= MIN_SPEAKEASY_TEXT_CHARS) return false;
  if (params.hasMedia || params.reply.mediaUrl || (params.reply.mediaUrls?.length ?? 0) > 0) {
    return false;
  }
  if (params.reply.audioAsVoice) return false;
  if (
    params.reply.channelData?.telegram?.buttons?.some((row) =>
      row.some((button) => button.callback_data?.startsWith(SPEAKEASY_VOICE_CALLBACK_PREFIX)),
    )
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
}): T {
  if (!shouldAttachSpeakeasyVoiceButton(params)) return params.reply;
  const id = createSpeakeasyCacheEntry({
    cfg: params.cfg!,
    chatId: params.chatId!,
    text: params.reply.text!.trim(),
  });
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
  const { stdout } = await execFileAsync(scriptPath, [params.text], {
    cwd: workspaceDir,
    maxBuffer: 1024 * 1024,
  });
  const outputPath = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
  if (!outputPath) {
    throw new Error("Speakeasy TTS did not print an output path");
  }
  return outputPath;
}
