import os from "node:os";
import path from "node:path";
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
  withFileLock,
} from "openclaw/plugin-sdk";

// ============================================================================
// 类型定义
// ============================================================================

/** 单条 reqId 记录 */
interface ReqIdEntry {
  /** 请求 ID */
  reqId: string;
  /** 记录时间戳（毫秒） */
  ts: number;
}

/** 磁盘存储的数据结构：chatId → ReqIdEntry */
type ReqIdStoreData = Record<string, ReqIdEntry>;

/** Store 配置 */
interface ReqIdStoreOptions {
  /** TTL 毫秒数，超时的 reqId 视为过期（默认 24 小时） */
  ttlMs?: number;
  /** 内存最大条目数（默认 200） */
  memoryMaxSize?: number;
  /** 磁盘最大条目数（默认 500） */
  fileMaxEntries?: number;
  /** 磁盘写入防抖时间（毫秒），默认 1000ms */
  flushDebounceMs?: number;
}

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const DEFAULT_MEMORY_MAX_SIZE = 200;
const DEFAULT_FILE_MAX_ENTRIES = 500;
const DEFAULT_FLUSH_DEBOUNCE_MS = 1000;

const DEFAULT_LOCK_OPTIONS = {
  stale: 60_000,
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
} as const;

// ============================================================================
// 状态目录解析
// ============================================================================

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveReqIdFilePath(accountId: string): string {
  const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveStateDirFromEnv(), "wecom", `reqid-map-${safe}.json`);
}

// ============================================================================
// 公开接口
// ============================================================================

export interface PersistentReqIdStore {
  /** 设置 chatId 对应的 reqId（写入内存 + 防抖写磁盘） */
  set(chatId: string, reqId: string): void;
  /** 获取 chatId 对应的 reqId（异步：优先内存，miss 时查磁盘并回填内存） */
  get(chatId: string): Promise<string | undefined>;
  /** 同步获取 chatId 对应的 reqId（仅内存） */
  getSync(chatId: string): string | undefined;
  /** 删除 chatId 对应的 reqId */
  delete(chatId: string): void;
  /** 启动时从磁盘预热内存，返回加载条目数 */
  warmup(onError?: (error: unknown) => void): Promise<number>;
  /** 立即将内存数据刷写到磁盘（用于优雅退出） */
  flush(): Promise<void>;
  /** 清空内存缓存 */
  clearMemory(): void;
  /** 返回内存中的条目数 */
  memorySize(): number;
}

// ============================================================================
// 核心实现
// ============================================================================

export function createPersistentReqIdStore(
  accountId: string,
  options?: ReqIdStoreOptions,
): PersistentReqIdStore {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const memoryMaxSize = options?.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE;
  const fileMaxEntries = options?.fileMaxEntries ?? DEFAULT_FILE_MAX_ENTRIES;
  const flushDebounceMs = options?.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;

  const filePath = resolveReqIdFilePath(accountId);

  // 内存层：chatId → ReqIdEntry
  const memory = new Map<string, ReqIdEntry>();

  // 防抖写入相关
  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ========== 内部辅助函数 ==========

  /** 检查条目是否过期 */
  function isExpired(entry: ReqIdEntry, now: number): boolean {
    return ttlMs > 0 && now - entry.ts >= ttlMs;
  }

  /** 验证磁盘条目的合法性 */
  function isValidEntry(entry: unknown): entry is ReqIdEntry {
    return (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ReqIdEntry).reqId === "string" &&
      typeof (entry as ReqIdEntry).ts === "number" &&
      Number.isFinite((entry as ReqIdEntry).ts)
    );
  }

  /** 清理磁盘数据中的无效值，返回干净的 Record */
  function sanitizeData(value: unknown): ReqIdStoreData {
    if (!value || typeof value !== "object") {
      return {};
    }
    const out: ReqIdStoreData = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isValidEntry(entry)) {
        out[key] = entry;
      }
    }
    return out;
  }

  /**
   * 内存容量控制：淘汰最旧的条目。
   * 利用 Map 的插入顺序 + touch(先 delete 再 set) 实现类 LRU 效果。
   */
  function pruneMemory(): void {
    if (memory.size <= memoryMaxSize) return;
    const sorted = [...memory.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = sorted.slice(0, memory.size - memoryMaxSize);
    for (const [key] of toRemove) {
      memory.delete(key);
    }
  }

  /** 磁盘数据容量控制：先清过期，再按时间淘汰超量 */
  function pruneFileData(data: ReqIdStoreData, now: number): void {
    if (ttlMs > 0) {
      for (const [key, entry] of Object.entries(data)) {
        if (now - entry.ts >= ttlMs) {
          delete data[key];
        }
      }
    }
    const keys = Object.keys(data);
    if (keys.length <= fileMaxEntries) return;
    keys
      .sort((a, b) => data[a].ts - data[b].ts)
      .slice(0, keys.length - fileMaxEntries)
      .forEach((key) => delete data[key]);
  }

  /** 防抖写入磁盘 */
  function scheduleDiskFlush(): void {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      if (!dirty) return;
      await flushToDisk();
    }, flushDebounceMs);
  }

  /** 立即写入磁盘（带文件锁，参考 createPersistentDedupe 的 checkAndRecordInner） */
  async function flushToDisk(): Promise<void> {
    dirty = false;
    const now = Date.now();
    try {
      await withFileLock(filePath, DEFAULT_LOCK_OPTIONS, async () => {
        // 读取现有磁盘数据并合并
        const { value } = await readJsonFileWithFallback<ReqIdStoreData>(filePath, {});
        const data = sanitizeData(value);

        // 将内存中未过期的数据合并到磁盘数据（内存优先）
        for (const [chatId, entry] of memory) {
          if (!isExpired(entry, now)) {
            data[chatId] = entry;
          }
        }

        // 清理过期和超量
        pruneFileData(data, now);

        // 原子写入
        await writeJsonFileAtomically(filePath, data);
      });
    } catch (error) {
      // 磁盘写入失败不影响内存使用，降级到纯内存模式
      console.error(`[WeCom] reqid-store: flush to disk failed: ${String(error)}`);
    }
  }

  // ========== 公开 API ==========

  function set(chatId: string, reqId: string): void {
    const entry: ReqIdEntry = { reqId, ts: Date.now() };
    // touch：先删再设，保持 Map 插入顺序（类 LRU）
    memory.delete(chatId);
    memory.set(chatId, entry);
    pruneMemory();
    scheduleDiskFlush();
  }

  async function get(chatId: string): Promise<string | undefined> {
    const now = Date.now();

    // 1. 先查内存
    const memEntry = memory.get(chatId);
    if (memEntry && !isExpired(memEntry, now)) {
      return memEntry.reqId;
    }
    if (memEntry) {
      memory.delete(chatId); // 过期则删除
    }

    // 2. 内存 miss，回查磁盘并回填内存
    try {
      const { value } = await readJsonFileWithFallback<ReqIdStoreData>(filePath, {});
      const data = sanitizeData(value);
      const diskEntry = data[chatId];
      if (diskEntry && !isExpired(diskEntry, now)) {
        // 回填内存
        memory.set(chatId, diskEntry);
        return diskEntry.reqId;
      }
    } catch {
      // 磁盘读取失败，降级返回 undefined
    }

    return undefined;
  }

  function getSync(chatId: string): string | undefined {
    const now = Date.now();
    const entry = memory.get(chatId);
    if (entry && !isExpired(entry, now)) {
      return entry.reqId;
    }
    if (entry) {
      memory.delete(chatId);
    }
    return undefined;
  }

  function del(chatId: string): void {
    memory.delete(chatId);
    scheduleDiskFlush();
  }

  async function warmup(onError?: (error: unknown) => void): Promise<number> {
    const now = Date.now();
    try {
      const { value } = await readJsonFileWithFallback<ReqIdStoreData>(filePath, {});
      const data = sanitizeData(value);
      let loaded = 0;
      for (const [chatId, entry] of Object.entries(data)) {
        if (!isExpired(entry, now)) {
          memory.set(chatId, entry);
          loaded++;
        }
      }
      pruneMemory();
      return loaded;
    } catch (error) {
      onError?.(error);
      return 0;
    }
  }

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushToDisk();
  }

  function clearMemory(): void {
    memory.clear();
  }

  function memorySize(): number {
    return memory.size;
  }

  return {
    set,
    get,
    getSync,
    delete: del,
    warmup,
    flush,
    clearMemory,
    memorySize,
  };
}
