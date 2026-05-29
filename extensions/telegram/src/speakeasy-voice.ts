import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  OpenClawConfig,
  TelegramInlineButtonsScope,
} from "openclaw/plugin-sdk/config-contracts";
import type { TelegramInlineButtons } from "./button-types.js";

export const SPEAKEASY_VOICE_CALLBACK_PREFIX = "tts:speakeasy:";
export const SPEAKEASY_VOICE_BUTTON_LABEL = "🔊 Voice note";
const MIN_SPEAKEASY_TEXT_CHARS = 20;
const SPEAKEASY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SPEAKEASY_DAILY_GENERATION_CAP = 50;
const SPEAKEASY_CACHE_LOCK_TIMEOUT_MS = 1000;
const SPEAKEASY_CACHE_LOCK_STALE_MS = 30_000;
const SPEAKEASY_TTS_TIMEOUT_MS = 120_000;
const SPEAKEASY_VOICE_NOTE_EXTENSIONS = new Set([".oga", ".ogg", ".opus"]);
const TELEGRAM_MAX_INLINE_BUTTON_ACTIONS = 100;
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
    if (now - entry.createdAt > SPEAKEASY_CACHE_TTL_MS) {
      delete cache.entries[id];
    }
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
  chmodExistingSpeakeasyCache(cachePath);
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(cachePath, 0o600);
}

function waitForSpeakeasyCacheLock(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

function chmodExistingSpeakeasyCache(cachePath: string): void {
  try {
    chmodSync(cachePath, 0o600);
  } catch (err) {
    if (!isFileNotFoundError(err)) {
      throw err;
    }
  }
}

function acquireSpeakeasyCacheLock(cachePath: string): () => void {
  const lockPath = `${cachePath}.lock`;
  const deadline = Date.now() + SPEAKEASY_CACHE_LOCK_TIMEOUT_MS;
  mkdirSync(path.dirname(cachePath), { recursive: true });
  while (true) {
    let fd: number | undefined;
    const lockToken = randomUUID();
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, lockToken, "utf8");
      return () => {
        if (fd !== undefined) {
          closeSync(fd);
        }
        try {
          if (readFileSync(lockPath, "utf8") === lockToken) {
            unlinkSync(lockPath);
          }
        } catch {
          // Best effort: another recovery path may have already removed a stale lock.
        }
      };
    } catch (err) {
      if (isFileAlreadyExistsError(err) && recoverStaleSpeakeasyCacheLock(lockPath)) {
        continue;
      }
      if (!isFileAlreadyExistsError(err) || Date.now() >= deadline) {
        throw err;
      }
      waitForSpeakeasyCacheLock();
    }
  }
}

function isFileAlreadyExistsError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "EEXIST");
}

function isFileNotFoundError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

function recoverStaleSpeakeasyCacheLock(lockPath: string): boolean {
  const claimPath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    linkSync(lockPath, claimPath);
    const claimStats = statSync(claimPath);
    const lockStats = statSync(lockPath);
    if (claimStats.dev !== lockStats.dev || claimStats.ino !== lockStats.ino) {
      return false;
    }
    const ageMs = Date.now() - claimStats.mtimeMs;
    if (ageMs < SPEAKEASY_CACHE_LOCK_STALE_MS) {
      return false;
    }
    const currentStats = statSync(lockPath);
    if (claimStats.dev !== currentStats.dev || claimStats.ino !== currentStats.ino) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(claimPath);
    } catch {
      // Best effort: the claim path may not exist if linking failed.
    }
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

function unmarkSpeakeasyVoiceGenerated(params: {
  cache: SpeakeasyVoiceCache;
  chatId: string;
  now?: Date;
}): void {
  const now = params.now ?? new Date();
  const key = generationKey(params.chatId, now);
  const current = params.cache.generations[key];
  if (!current || current.date !== todayKey(now)) {
    return;
  }
  if (current.count <= 1) {
    delete params.cache.generations[key];
    return;
  }
  params.cache.generations[key] = {
    date: current.date,
    count: current.count - 1,
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

function updateSpeakeasyCacheWithLock<T>(
  cfg: OpenClawConfig,
  updater: (cache: SpeakeasyVoiceCache) => T,
): T {
  const cachePath = resolveSpeakeasyCachePath(cfg);
  const releaseLock = acquireSpeakeasyCacheLock(cachePath);
  try {
    const latest = loadSpeakeasyCache(cfg);
    const result = updater(latest);
    writeSpeakeasyCache(cfg, latest);
    return result;
  } finally {
    releaseLock();
  }
}

function createSpeakeasyCacheEntry(params: {
  cfg: OpenClawConfig;
  chatId: string;
  text: string;
}): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  const entry = {
    chatId: params.chatId,
    text: params.text,
    createdAt: Date.now(),
  };
  updateSpeakeasyCacheWithLock(params.cfg, (latest) => {
    latest.entries[id] = entry;
  });
  return id;
}

export function reserveSpeakeasyVoiceGeneration(params: {
  cfg: OpenClawConfig;
  data: string;
  chatId: string;
}): { ok: true; text: string } | { ok: false; reason: "miss" | "expired" | "disabled" | "limit" } {
  return updateSpeakeasyCacheWithLock(params.cfg, (cache) => {
    const resolved = resolveSpeakeasyCachedText({
      cfg: params.cfg,
      cache,
      data: params.data,
      chatId: params.chatId,
    });
    if (!resolved.ok) {
      return resolved;
    }
    if (!shouldAllowSpeakeasyVoiceGeneration({ cache, chatId: params.chatId })) {
      return { ok: false, reason: "limit" };
    }
    markSpeakeasyVoiceGenerated({ cache, chatId: params.chatId });
    return resolved;
  });
}

export function releaseSpeakeasyVoiceGenerationReservation(params: {
  cfg: OpenClawConfig;
  chatId: string;
}): void {
  updateSpeakeasyCacheWithLock(params.cfg, (cache) => {
    unmarkSpeakeasyVoiceGenerated({ cache, chatId: params.chatId });
  });
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
  let id: string;
  try {
    id = createSpeakeasyCacheEntry({
      cfg: params.cfg!,
      chatId: params.chatId!,
      text: params.reply.text!.trim(),
    });
  } catch {
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
  assertSpeakeasyVoiceNoteOutputPath(outputPath);
  return outputPath;
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
      if (stdout.length > 1024 * 1024) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
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
