/**
 * Session 持久化存储
 * 将 WebSocket 连接状态（sessionId、lastSeq）持久化到文件
 * 支持进程重启后通过 Resume 机制快速恢复连接
 */

import fs from "node:fs";
import path from "node:path";

// Session 状态接口
export interface SessionState {
  /** WebSocket Session ID */
  sessionId: string | null;
  /** 最后收到的消息序号 */
  lastSeq: number | null;
  /** 上次连接成功的时间戳 */
  lastConnectedAt: number;
  /** 上次成功的权限级别索引 */
  intentLevelIndex: number;
  /** 关联的机器人账户 ID */
  accountId: string;
  /** 保存时间 */
  savedAt: number;
}

// Session 文件目录
const SESSION_DIR = path.join(process.env.HOME || "/tmp", "clawd", "qqbot-data");

// Session 过期时间（5分钟）- Resume 要求在断开后一定时间内恢复
const SESSION_EXPIRE_TIME = 5 * 60 * 1000;

// 写入节流时间（避免频繁写入）
const SAVE_THROTTLE_MS = 1000;

// 每个账户的节流状态
const throttleState = new Map<
  string,
  {
    pendingState: SessionState | null;
    lastSaveTime: number;
    throttleTimer: ReturnType<typeof setTimeout> | null;
  }
>();

/**
 * 确保目录存在
 */
function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

/**
 * 获取 Session 文件路径
 */
function getSessionPath(accountId: string): string {
  // 清理 accountId 中的特殊字符
  const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(SESSION_DIR, `session-${safeId}.json`);
}

/**
 * 加载 Session 状态
 * @param accountId 账户 ID
 * @returns Session 状态，如果不存在或已过期返回 null
 */
export function loadSession(accountId: string): SessionState | null {
  const filePath = getSessionPath(accountId);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = fs.readFileSync(filePath, "utf-8");
    const state = JSON.parse(data) as SessionState;

    // 检查是否过期
    const now = Date.now();
    if (now - state.savedAt > SESSION_EXPIRE_TIME) {
      console.log(
        `[session-store] Session expired for ${accountId}, age: ${Math.round((now - state.savedAt) / 1000)}s`,
      );
      // 删除过期文件
      try {
        fs.unlinkSync(filePath);
      } catch {
        // 忽略删除错误
      }
      return null;
    }

    // 验证必要字段
    if (!state.sessionId || state.lastSeq === null || state.lastSeq === undefined) {
      console.log(`[session-store] Invalid session data for ${accountId}`);
      return null;
    }

    console.log(
      `[session-store] Loaded session for ${accountId}: sessionId=${state.sessionId}, lastSeq=${state.lastSeq}, age=${Math.round((now - state.savedAt) / 1000)}s`,
    );
    return state;
  } catch (err) {
    console.error(`[session-store] Failed to load session for ${accountId}: ${String(err)}`);
    return null;
  }
}

/**
 * 保存 Session 状态（带节流，避免频繁写入）
 * @param state Session 状态
 */
export function saveSession(state: SessionState): void {
  const { accountId } = state;

  // 获取或初始化节流状态
  let throttle = throttleState.get(accountId);
  if (!throttle) {
    throttle = {
      pendingState: null,
      lastSaveTime: 0,
      throttleTimer: null,
    };
    throttleState.set(accountId, throttle);
  }

  const now = Date.now();
  const timeSinceLastSave = now - throttle.lastSaveTime;

  // 如果距离上次保存时间足够长，立即保存
  if (timeSinceLastSave >= SAVE_THROTTLE_MS) {
    doSaveSession(state);
    throttle.lastSaveTime = now;
    throttle.pendingState = null;

    // 清除待定的节流定时器
    if (throttle.throttleTimer) {
      clearTimeout(throttle.throttleTimer);
      throttle.throttleTimer = null;
    }
  } else {
    // 记录待保存的状态
    throttle.pendingState = state;

    // 如果没有设置定时器，设置一个
    if (!throttle.throttleTimer) {
      const delay = SAVE_THROTTLE_MS - timeSinceLastSave;
      throttle.throttleTimer = setTimeout(() => {
        const t = throttleState.get(accountId);
        if (t && t.pendingState) {
          doSaveSession(t.pendingState);
          t.lastSaveTime = Date.now();
          t.pendingState = null;
        }
        if (t) {
          t.throttleTimer = null;
        }
      }, delay);
    }
  }
}

/**
 * 实际执行保存操作
 */
function doSaveSession(state: SessionState): void {
  const filePath = getSessionPath(state.accountId);

  try {
    ensureDir();

    // 更新保存时间
    const stateToSave: SessionState = {
      ...state,
      savedAt: Date.now(),
    };

    fs.writeFileSync(filePath, JSON.stringify(stateToSave, null, 2), "utf-8");
    console.log(
      `[session-store] Saved session for ${state.accountId}: sessionId=${state.sessionId}, lastSeq=${state.lastSeq}`,
    );
  } catch (err) {
    console.error(`[session-store] Failed to save session for ${state.accountId}: ${String(err)}`);
  }
}

/**
 * 清除 Session 状态
 * @param accountId 账户 ID
 */
export function clearSession(accountId: string): void {
  const filePath = getSessionPath(accountId);

  // 清除节流状态
  const throttle = throttleState.get(accountId);
  if (throttle) {
    if (throttle.throttleTimer) {
      clearTimeout(throttle.throttleTimer);
    }
    throttleState.delete(accountId);
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[session-store] Cleared session for ${accountId}`);
    }
  } catch (err) {
    console.error(`[session-store] Failed to clear session for ${accountId}: ${String(err)}`);
  }
}

/**
 * 更新 lastSeq（轻量级更新）
 * @param accountId 账户 ID
 * @param lastSeq 最新的消息序号
 */
export function updateLastSeq(accountId: string, lastSeq: number): void {
  const existing = loadSession(accountId);
  if (existing && existing.sessionId) {
    saveSession({
      ...existing,
      lastSeq,
    });
  }
}

/**
 * 获取所有保存的 Session 状态
 */
export function getAllSessions(): SessionState[] {
  const sessions: SessionState[] = [];

  try {
    ensureDir();
    const files = fs.readdirSync(SESSION_DIR);

    for (const file of files) {
      if (file.startsWith("session-") && file.endsWith(".json")) {
        const filePath = path.join(SESSION_DIR, file);
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const state = JSON.parse(data) as SessionState;
          sessions.push(state);
        } catch {
          // 忽略解析错误
        }
      }
    }
  } catch {
    // 目录不存在等错误
  }

  return sessions;
}

/**
 * 清理过期的 Session 文件
 */
export function cleanupExpiredSessions(): number {
  let cleaned = 0;

  try {
    ensureDir();
    const files = fs.readdirSync(SESSION_DIR);
    const now = Date.now();

    for (const file of files) {
      if (file.startsWith("session-") && file.endsWith(".json")) {
        const filePath = path.join(SESSION_DIR, file);
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const state = JSON.parse(data) as SessionState;

          if (now - state.savedAt > SESSION_EXPIRE_TIME) {
            fs.unlinkSync(filePath);
            cleaned++;
            console.log(`[session-store] Cleaned expired session: ${file}`);
          }
        } catch {
          // 忽略解析错误，但也删除损坏的文件
          try {
            fs.unlinkSync(filePath);
            cleaned++;
          } catch {
            // 忽略
          }
        }
      }
    }
  } catch {
    // 目录不存在等错误
  }

  return cleaned;
}
