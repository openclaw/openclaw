/**
 * Engram Memory Plugin for OpenClaw
 *
 * 雙向橋接：
 *   RETRIEVE: before_prompt_build → POST /retrieve + /concepts → prependSystemContext
 *   WRITE:    agent_end → 從 messages 提取最後一輪 → POST /add (靜默)
 *
 * API 簽名：export default function(api: OpenClawPluginApi)
 *   api.config         → openclaw config
 *   api.pluginConfig   → 本 plugin 的 config
 *   api.runtime        → PluginRuntime (logging, events, state, ...)
 *   api.logger         → PluginLogger
 *   api.on(hookName, handler, opts) → register typed hook
 */

import fs from "fs";
import path from "path";

// ── 工具函數 ────────────────────────────────────────────────

/** 向 Engram 發 POST，失敗靜默 */
async function engramPost(baseUrl, endpoint, body, logger) {
  try {
    const resp = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    logger?.debug?.(`[engram] ${endpoint} unreachable`);
    return null;
  }
}

/** 簡易情感分類：含強烈決策/情感關鍵字 → high，其餘 → low */
function classifyEmotional(text) {
  const highSignals = [
    "決定",
    "決策",
    "失敗",
    "成功",
    "重要",
    "緊急",
    "錯誤",
    "教訓",
    "警告",
    "風險",
    "平倉",
    "爆倉",
    "虧損",
    "獲利",
    "授權",
    "important",
    "critical",
    "error",
    "failed",
    "success",
    "warning",
  ];
  const lower = text.toLowerCase();
  const hits = highSignals.filter((s) => lower.includes(s)).length;
  if (hits >= 2) return 0.75;
  if (hits === 1) return 0.55;
  return 0.3;
}

/** 解析 time_from/time_to（UTC Unix timestamp） */
function parseTimeRange(query) {
  const now = Math.floor(Date.now() / 1000);
  const todayStart = now - (now % 86400);
  if (/今天|今日/.test(query)) return [todayStart, now];
  if (/昨天/.test(query)) return [todayStart - 86400, todayStart - 1];
  if (/這兩天|最近兩天/.test(query)) return [todayStart - 86400, now];
  const m = query.match(/(最近|這|近)(\d+)天/);
  if (m) return [todayStart - (parseInt(m[2], 10) - 1) * 86400, now];
  return [null, null];
}

/** 從 agent_end 的 messages 陣列提取最後一輪 user + assistant 文字 */
function extractLastTurnFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { user: null, assistant: null };

  let lastAssistant = null;
  let lastUser = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg?.role ?? msg?.message?.role;
    const content = msg?.content ?? msg?.message?.content;

    const extractText = (c) => {
      if (typeof c === "string") return c.trim();
      if (Array.isArray(c)) {
        return c
          .filter((p) => p?.type === "text")
          .map((p) => p.text ?? "")
          .join(" ")
          .trim();
      }
      return "";
    };

    if (!lastAssistant && role === "assistant") {
      const text = extractText(content);
      if (text) lastAssistant = text;
    }

    if (lastAssistant && !lastUser && role === "user") {
      const text = extractText(content);
      // 跳過 system/heartbeat 注入
      if (text && !text.startsWith("System:") && text.length > 10) {
        lastUser = text;
        break;
      }
    }
  }

  return { user: lastUser, assistant: lastAssistant };
}

/** 格式化 Engram 記憶為 system prompt 片段 */
function formatMemoriesForPrompt(memories, concepts) {
  const lines = [];

  if (concepts?.length) {
    lines.push("### [Engram 概念層]");
    for (const c of concepts) {
      const ltm = c.is_long_term ? " [LTM]" : "";
      lines.push(`- ${c.label}${ltm}`);
    }
  }

  if (memories?.length) {
    lines.push("### [Engram 記憶層]");
    for (const m of memories) {
      const preview = m.content.slice(0, 200).replace(/\n/g, " ");
      lines.push(`- ${preview}`);
    }
  }

  if (!lines.length) return null;
  return lines.join("\n");
}

// ── Plugin 入口 ─────────────────────────────────────────────

export default function register(api) {
  const cfg = api.pluginConfig ?? {};
  const BASE_URL = cfg.baseUrl ?? "http://localhost:3000";
  const MAX_RESULTS = cfg.maxResults ?? 5;
  const MAX_CONCEPTS = cfg.maxConcepts ?? 3;
  const WRITE_ENABLED = cfg.writeEnabled !== false;
  const SESSION_FILTER = cfg.sessionFilter ?? "agent:main:";

  const log = api.logger;

  // ── 1. RETRIEVE: 每次 prompt 組建前注入記憶 ──────────────
  api.on(
    "before_prompt_build",
    async (event, ctx) => {
      // 跳過 heartbeat（不想浪費 tokens）
      if (ctx.trigger === "heartbeat") return;

      const query = (event.prompt ?? "").slice(0, 500);
      if (!query || query.length < 3) return;

      const [timeFrom, timeTo] = parseTimeRange(query);
      const payload = { query, max_results: MAX_RESULTS };
      if (timeFrom != null) payload.time_from = timeFrom;
      if (timeTo != null) payload.time_to = timeTo;

      const [memResult, conResult] = await Promise.all([
        engramPost(BASE_URL, "/retrieve", payload, log),
        engramPost(BASE_URL, "/concepts", { query, max_results: MAX_CONCEPTS }, log),
      ]);

      const memories = memResult?.memories ?? [];
      const concepts = conResult?.concepts ?? [];

      if (!memories.length && !concepts.length) return;

      const injected = formatMemoriesForPrompt(memories, concepts);
      if (!injected) return;

      log.debug?.(`[engram] inject ${memories.length} mem + ${concepts.length} concepts`);
      return { prependSystemContext: injected + "\n" };
    },
    { priority: 20 },
  );

  // ── 2. WRITE: turn 結束後寫入 Engram ─────────────────────
  if (WRITE_ENABLED) {
    api.on("agent_end", async (event, ctx) => {
      // 只處理成功的 turn
      if (!event.success) return;

      // 過濾 session prefix（只記主對話，不記 subagent）
      const sessionKey = ctx.sessionKey ?? "";
      if (SESSION_FILTER && !sessionKey.includes(SESSION_FILTER)) return;

      const { user, assistant } = extractLastTurnFromMessages(event.messages);

      if (user) {
        const emotional = classifyEmotional(user);
        engramPost(
          BASE_URL,
          "/add",
          {
            content: user.slice(0, 2000),
            type: emotional > 0.6 ? 2 : 1,
            emotional,
          },
          log,
        );
      }

      if (assistant) {
        engramPost(
          BASE_URL,
          "/add",
          {
            content: assistant.slice(0, 2000),
            type: 1,
            emotional: 0.25,
          },
          log,
        );
      }
    });
  }
}
