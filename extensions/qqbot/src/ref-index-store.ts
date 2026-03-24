/**
 * QQ Bot 引用索引持久化存储
 *
 * QQ Bot 使用 REFIDX_xxx 索引体系做引用消息，
 * 入站事件只有索引值，无 API 可回查内容。
 * 采用 内存缓存 + JSONL 追加写持久化 方案，确保重启后历史引用仍可命中。
 *
 * 存储位置：~/.openclaw/qqbot/data/ref-index.jsonl
 *
 * 每行格式：{"k":"REFIDX_xxx","v":{...},"t":1709000000}
 * - k = refIdx 键
 * - v = 消息数据
 * - t = 写入时间（用于 TTL 淘汰和 compact）
 */

import fs from "node:fs";
import path from "node:path";
import { debugLog, debugError } from "./utils/debug-log.js";
import { getQQBotDataDir } from "./utils/platform.js";

// ============ 存储的消息摘要 ============

export interface RefIndexEntry {
  /** 消息文本内容（完整保存） */
  content: string;
  /** 发送者 ID */
  senderId: string;
  /** 发送者名称 */
  senderName?: string;
  /** 消息时间戳 (ms) */
  timestamp: number;
  /** 是否是 bot 发出的消息 */
  isBot?: boolean;
  /** 附件摘要（图片/语音/视频/文件等） */
  attachments?: RefAttachmentSummary[];
}

/** 附件摘要：存本地路径、在线 URL 和类型描述 */
export interface RefAttachmentSummary {
  /** 附件类型 */
  type: "image" | "voice" | "video" | "file" | "unknown";
  /** 文件名（如有） */
  filename?: string;
  /** MIME 类型 */
  contentType?: string;
  /** 语音转录文本（入站：STT/ASR识别结果；出站：TTS原文本） */
  transcript?: string;
  /** 语音转录来源：stt=本地STT、asr=平台ASR、tts=TTS原文本、fallback=兜底文案 */
  transcriptSource?: "stt" | "asr" | "tts" | "fallback";
  /** 已下载到本地的文件路径（持久化后可供引用时访问） */
  localPath?: string;
  /** 在线来源 URL（公网图片/文件等） */
  url?: string;
}

// ============ 配置 ============

const STORAGE_DIR = getQQBotDataDir("data");
const REF_INDEX_FILE = path.join(STORAGE_DIR, "ref-index.jsonl");
const MAX_ENTRIES = 50000; // 内存中最大缓存条目数
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const COMPACT_THRESHOLD_RATIO = 2; // 文件行数超过有效条目 N 倍时 compact

// ============ JSONL 行格式 ============

interface RefIndexLine {
  /** refIdx 键 */
  k: string;
  /** 消息数据 */
  v: RefIndexEntry;
  /** 写入时间 (ms) */
  t: number;
}

// ============ 内存缓存 ============

let cache: Map<string, RefIndexEntry & { _createdAt: number }> | null = null;
let totalLinesOnDisk = 0; // 磁盘文件总行数（含过期 / 被覆盖的）

/**
 * 从 JSONL 文件加载到内存（懒加载，首次访问时触发）
 */
function loadFromFile(): Map<string, RefIndexEntry & { _createdAt: number }> {
  if (cache !== null) return cache;

  cache = new Map();
  totalLinesOnDisk = 0;

  try {
    if (!fs.existsSync(REF_INDEX_FILE)) {
      return cache;
    }

    const raw = fs.readFileSync(REF_INDEX_FILE, "utf-8");
    const lines = raw.split("\n");
    const now = Date.now();
    let expired = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      totalLinesOnDisk++;

      try {
        const entry = JSON.parse(trimmed) as RefIndexLine;
        if (!entry.k || !entry.v || !entry.t) continue;

        // 跳过过期条目
        if (now - entry.t > TTL_MS) {
          expired++;
          continue;
        }

        cache.set(entry.k, {
          ...entry.v,
          _createdAt: entry.t,
        });
      } catch {
        // 跳过损坏的行
      }
    }

    debugLog(
      `[ref-index-store] Loaded ${cache.size} entries from ${totalLinesOnDisk} lines (${expired} expired)`,
    );

    // 启动时检查是否需要 compact
    if (shouldCompact()) {
      compactFile();
    }
  } catch (err) {
    debugError(`[ref-index-store] Failed to load: ${err}`);
    cache = new Map();
  }

  return cache;
}

// ============ JSONL 追加写入 ============

/**
 * 追加一行到 JSONL 文件
 */
function appendLine(line: RefIndexLine): void {
  try {
    ensureDir();
    fs.appendFileSync(REF_INDEX_FILE, JSON.stringify(line) + "\n", "utf-8");
    totalLinesOnDisk++;
  } catch (err) {
    debugError(`[ref-index-store] Failed to append: ${err}`);
  }
}

function ensureDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

// ============ Compact：重写文件，去除过期和被覆盖的条目 ============

function shouldCompact(): boolean {
  if (!cache) return false;
  // 文件行数远超有效条目数时 compact
  return totalLinesOnDisk > cache.size * COMPACT_THRESHOLD_RATIO && totalLinesOnDisk > 1000;
}

function compactFile(): void {
  if (!cache) return;

  const before = totalLinesOnDisk;
  try {
    ensureDir();
    const tmpPath = REF_INDEX_FILE + ".tmp";
    const lines: string[] = [];

    for (const [key, entry] of cache) {
      const line: RefIndexLine = {
        k: key,
        v: {
          content: entry.content,
          senderId: entry.senderId,
          senderName: entry.senderName,
          timestamp: entry.timestamp,
          isBot: entry.isBot,
          attachments: entry.attachments,
        },
        t: entry._createdAt,
      };
      lines.push(JSON.stringify(line));
    }

    fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
    fs.renameSync(tmpPath, REF_INDEX_FILE);
    totalLinesOnDisk = cache.size;
    debugLog(`[ref-index-store] Compacted: ${before} lines → ${totalLinesOnDisk} lines`);
  } catch (err) {
    debugError(`[ref-index-store] Compact failed: ${err}`);
  }
}

// ============ 溢出淘汰 ============

function evictIfNeeded(): void {
  if (!cache || cache.size < MAX_ENTRIES) return;

  const now = Date.now();
  // 第一轮：清理过期
  for (const [key, entry] of cache) {
    if (now - entry._createdAt > TTL_MS) {
      cache.delete(key);
    }
  }

  // 第二轮：仍超限，按时间删最旧
  if (cache.size >= MAX_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1]._createdAt - b[1]._createdAt);
    const toRemove = sorted.slice(0, cache.size - MAX_ENTRIES + 1000);
    for (const [key] of toRemove) {
      cache.delete(key);
    }
    debugLog(`[ref-index-store] Evicted ${toRemove.length} oldest entries`);
  }
}

// ============ 公共 API ============

/**
 * 存储一条消息的 refIdx 映射
 */
export function setRefIndex(refIdx: string, entry: RefIndexEntry): void {
  const store = loadFromFile();
  evictIfNeeded();

  const now = Date.now();
  store.set(refIdx, {
    content: entry.content,
    senderId: entry.senderId,
    senderName: entry.senderName,
    timestamp: entry.timestamp,
    isBot: entry.isBot,
    attachments: entry.attachments,
    _createdAt: now,
  });

  // 追加写入 JSONL
  appendLine({
    k: refIdx,
    v: {
      content: entry.content,
      senderId: entry.senderId,
      senderName: entry.senderName,
      timestamp: entry.timestamp,
      isBot: entry.isBot,
      attachments: entry.attachments,
    },
    t: now,
  });

  // 检查是否需要 compact
  if (shouldCompact()) {
    compactFile();
  }
}

/**
 * 查找被引用消息
 */
export function getRefIndex(refIdx: string): RefIndexEntry | null {
  const store = loadFromFile();
  const entry = store.get(refIdx);
  if (!entry) return null;

  // 检查过期
  if (Date.now() - entry._createdAt > TTL_MS) {
    store.delete(refIdx);
    return null;
  }

  return {
    content: entry.content,
    senderId: entry.senderId,
    senderName: entry.senderName,
    timestamp: entry.timestamp,
    isBot: entry.isBot,
    attachments: entry.attachments,
  };
}

/**
 * 将引用消息内容格式化为人类可读的描述（供 AI 上下文注入）
 */
export function formatRefEntryForAgent(entry: RefIndexEntry): string {
  const parts: string[] = [];

  // 文本内容
  if (entry.content.trim()) {
    parts.push(entry.content);
  }

  // 附件描述
  if (entry.attachments?.length) {
    for (const att of entry.attachments) {
      const sourceHint = att.localPath ? ` (${att.localPath})` : att.url ? ` (${att.url})` : "";
      switch (att.type) {
        case "image":
          parts.push(`[图片${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        case "voice":
          if (att.transcript) {
            const sourceMap = {
              stt: "本地识别",
              asr: "官方识别",
              tts: "TTS原文",
              fallback: "兜底文案",
            };
            const sourceTag = att.transcriptSource
              ? ` - ${sourceMap[att.transcriptSource] || att.transcriptSource}`
              : "";
            parts.push(`[语音消息（内容: "${att.transcript}"${sourceTag}）${sourceHint}]`);
          } else {
            parts.push(`[语音消息${sourceHint}]`);
          }
          break;
        case "video":
          parts.push(`[视频${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        case "file":
          parts.push(`[文件${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        default:
          parts.push(`[附件${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
      }
    }
  }

  return parts.join(" ") || "[空消息]";
}

/**
 * 进程退出前强制 compact（确保数据一致性）
 */
export function flushRefIndex(): void {
  if (cache && shouldCompact()) {
    compactFile();
  }
}

/**
 * 缓存统计（调试用）
 */
export function getRefIndexStats(): {
  size: number;
  maxEntries: number;
  totalLinesOnDisk: number;
  filePath: string;
} {
  const store = loadFromFile();
  return {
    size: store.size,
    maxEntries: MAX_ENTRIES,
    totalLinesOnDisk,
    filePath: REF_INDEX_FILE,
  };
}
