// extensions/gemma-memory-intercept/index.ts
//
// gemma-memory P2.25c option F: plugin-level toolCall intercept.
//
// When a user sends a natural-language memo / recall / journal request to
// agentId="gemma" via Telegram (DM or group), the model has a strong prior
// from its training data to start with `read({path:"*SKILL.md"})` or
// `exec({command:"find ..."})` even though the workspace TOOLS/AGENTS/BOOTSTRAP
// docs forbid those paths and require `bash scripts/recall.sh "<원문>"` instead.
// Prompt-level enforcement (P2.25a/b/c) was insufficient on DM channel.
//
// This plugin enforces the rule at the OpenClaw hook level:
//   1. message_received -> cache user text per (sessionKey,sessionId,runId),
//      if it matches the natural-language memo signal.
//   2. before_tool_call -> if the cached message exists and the first toolCall
//      matches a forbidden pattern, block it with a reason that steers the
//      model to bash scripts/recall.sh.
//
// Scope: agentId === "gemma" ONLY. Other agents (main/Claw, gemma-kevin,
// luna) are not affected.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// ---------------------------------------------------------------------------
// Pattern definitions (kept in sync with workspace/scripts/recall.sh).
// If you change any of these, change recall.sh too and vice versa.
// ---------------------------------------------------------------------------

const INTENT_PATTERNS: RegExp[] = [
  // DELETE
  /지워줘|지워|삭제해|삭제|잊어버려|잘못\s*적었어|빼줘|없애줘/,
  // EDIT
  /고쳐줘|수정해|바꿔줘|바꿔/,
  // WRITE
  /적어둬|적어줘|메모해둬|메모해|기록해둬|기록해줘|기록해|저장해|남겨둬|남겨줘/,
  // SEARCH
  /찾아줘|어디에\s*있어|어디에\s*있더라|어디\s*갔지/,
  // READ / RECALL
  /보여줘|보여줄래|알려줘|다시\s*봐|다시\s*보자|어떻게\s*됐어|얼마였더라|뭐였더라|봐줘|봐\s*줘|보자|기억나|기억해|기억\s*안\s*나|기억이\s*안/,
  // PERSON-RECALL (2026-05-24 P2.25c route 1 fix): "누구" 류 인물 회상
  /누구지|누구야|누구더라|누구였더라|누구였지|누구냐|누구였\b/,
];

const TIME_PATTERNS: RegExp[] = [
  /오늘|어제|그제|그저께|내일|모레|지난주|저번주|이번주|지난달|저번달|이번달|작년|올해|하루\s*전|이틀\s*전|사흘\s*전|며칠\s*전|그때|그날|그\s*날/,
];

const HANGUL_TOKEN_RE = /[가-힣]{2,}/;

const FORBIDDEN_EXEC_HEAD_RE = /^\s*(find|ind|fnd|grep|cat|ls\s+-[a-zA-Z]*[Rr][a-zA-Z]*|ls\s+-l)\b/;
const DIRECT_MEMORY_SH_RE = /\bscripts\/(memory|person)\.sh\b/;
const RECALL_SH_RE = /\bscripts\/recall\.sh\b/;

// SKILL.md path matcher (case-insensitive, trailing-anchored). Also catches
// "...SKILL.md", "memory-search/SKILL.md", "skill-creator/SKILL.md", etc.
const SKILL_MD_PATH_RE = /SKILL\.md\s*$/i;

// MD profile files inside agent workspace that the model often "reads"
// instead of calling recall.sh. read({path:"SOUL.md"}), MEMORY.md, USER.md,
// TOOLS.md, AGENTS.md etc. — these are already in systemPrompt; opening them
// via the read tool is wasted bandwidth and a signal the model is bypassing
// recall.sh.
const WORKSPACE_PROFILE_MD_RE =
  /\/?(?:SOUL|IDENTITY|USER|MEMORY|AGENTS|TOOLS|BOOTSTRAP|HEARTBEAT)\.md\s*$/;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function looksLikeNaturalMemoRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < 4) return false;
  if (t.startsWith("/")) return false; // slash command, not natural language
  // If the user is already telling the model to call recall.sh, skip.
  if (RECALL_SH_RE.test(t)) return false;

  const hasIntent = INTENT_PATTERNS.some((p) => p.test(t));
  const hasTime = TIME_PATTERNS.some((p) => p.test(t));
  const hasNoun = HANGUL_TOKEN_RE.test(t);

  return (hasIntent || hasTime) && hasNoun;
}

export function detectForbiddenCall(
  toolName: string,
  params: Record<string, unknown> | undefined,
): string | null {
  const p = params ?? {};
  const name = String(toolName ?? "").toLowerCase();

  // read({path:"...SKILL.md"}) or read on workspace profile mds
  if (name === "read") {
    const pathStr = String(
      (p as { path?: unknown }).path ?? (p as { file_path?: unknown }).file_path ?? "",
    );
    if (SKILL_MD_PATH_RE.test(pathStr)) {
      return `read({path:"${truncate(pathStr, 80)}"}) — SKILL.md path`;
    }
    if (WORKSPACE_PROFILE_MD_RE.test(pathStr)) {
      return `read({path:"${truncate(pathStr, 80)}"}) — workspace profile MD (already in system prompt)`;
    }
  }

  // exec/bash direct filesystem explorers and memory.sh/person.sh shortcuts
  if (name === "exec" || name === "bash") {
    const cmdRaw = String(
      (p as { command?: unknown }).command ??
        (p as { cmd?: unknown }).cmd ??
        (p as { script?: unknown }).script ??
        "",
    );
    if (!cmdRaw) return null;

    // already routed to recall.sh — allow.
    if (RECALL_SH_RE.test(cmdRaw)) return null;

    if (FORBIDDEN_EXEC_HEAD_RE.test(cmdRaw)) {
      const head = cmdRaw.replace(/^\s+/, "").split(/\s/, 1)[0];
      return `${name}({command:"${head} ..."}) — direct fs explorer`;
    }
    if (DIRECT_MEMORY_SH_RE.test(cmdRaw)) {
      return `${name}({command:"... memory.sh|person.sh ..."}) — direct script (must go via recall.sh)`;
    }
  }

  return null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

// ---------------------------------------------------------------------------
// Block reason text — what the model sees and learns from.
// ---------------------------------------------------------------------------

function buildBlockReason(originalCall: string, userText: string): string {
  const sample = truncate(userText.replace(/\n/g, " "), 200).replace(/"/g, '\\"');
  return (
    `자연어 메모/일지/회상 요청 감지 (P2.25c 옵션 F). ` +
    `차단된 호출: ${originalCall}. ` +
    `허용된 단일 호출: exec({command: "bash scripts/recall.sh \\"${sample}\\""}). ` +
    `find/grep/cat/ls -R/memory.sh/person.sh/SKILL.md/profile MD 직접 호출 모두 차단됨. ` +
    `recall.sh 가 자연어 1줄을 받아 intent 분류 + 시간/명사/인물 추출 + 도구 시퀀스를 자동 처리.`
  );
}

// ---------------------------------------------------------------------------
// Per-session cache of the latest user text + first-call flag
// ---------------------------------------------------------------------------

type CacheEntry = {
  text: string;
  firstToolCallSeen: boolean;
  ts: number;
};

const userTextCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_CAP = 1000;

function cacheKey(agentId: string | undefined, conversationId: string | undefined): string {
  // P2.25c route 1 fix (2026-05-24): PluginHookMessageContext lacks
  // sessionKey/sessionId/runId. Use agentId+conversationId for cross-hook
  // matching. In message_received ctx provides accountId/channelId/conversationId
  // (channel-scoped); in before_tool_call ctx provides agentId/sessionKey.
  // We map sessionKey → conversationId via sessionKeyToConversationId().
  return `${agentId ?? ""}|${conversationId ?? ""}`;
}

// P2.25c route 1 fix: extract conversation id (telegram chat_id) from sessionKey.
// sessionKey format observed (nohup.log hook-shape):
//   "agent:gemma:telegram:direct:56682682"      → "56682682"
//   "agent:gemma:telegram:group:-1003821022499" → "-1003821022499"
// Returns undefined if format doesn't match (e.g. non-telegram or unexpected layout).
function sessionKeyToConversationId(sessionKey: string | undefined): string | undefined {
  if (typeof sessionKey !== "string" || !sessionKey) return undefined;
  const m = /^agent:[^:]+:[^:]+:(?:direct|group):(.+)$/.exec(sessionKey);
  return m ? m[1] : undefined;
}

function pruneCache(): void {
  const now = Date.now();
  for (const [k, v] of userTextCache) {
    if (now - v.ts > CACHE_TTL_MS) userTextCache.delete(k);
  }
  if (userTextCache.size > CACHE_CAP) {
    const overflow = userTextCache.size - CACHE_CAP;
    const it = userTextCache.keys();
    for (let i = 0; i < overflow; i++) {
      const k = it.next().value;
      if (typeof k === "string") userTextCache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Counters (exposed via debug logger; not a registered command in this
// version to minimize OpenClaw surface area).
// ---------------------------------------------------------------------------

const counters = {
  messagesSeen: 0,
  naturalMemoMatched: 0,
  toolCallsInspected: 0,
  blocked: 0,
  skippedNotGemma: 0,
  skippedNotFirstCall: 0,
  skippedNoMatch: 0,
  skippedAllowed: 0,
};

export function __dumpCounters(): Record<string, number> {
  return { ...counters, cacheSize: userTextCache.size };
}

// ---------------------------------------------------------------------------
// Helpers for extracting user text from message_received events. The shape
// can vary by channel; this is best-effort.
// ---------------------------------------------------------------------------

function extractUserText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const ev = event as Record<string, unknown>;

  // common shapes
  const m = ev["message"];
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    const t = (m as Record<string, unknown>)["text"];
    if (typeof t === "string") return t;
    const c = (m as Record<string, unknown>)["content"];
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const joined = c
        .map((seg) =>
          seg && typeof seg === "object" && typeof (seg as { text?: unknown }).text === "string"
            ? (seg as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (joined) return joined;
    }
  }
  if (typeof ev["text"] === "string") return ev["text"] as string;
  if (typeof ev["content"] === "string") return ev["content"] as string;
  return "";
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

export default (api: OpenClawPluginApi) => {
  const { logger } = api;

  // P2.25c hook-debug: confirm plugin registration on every load
  logger.info(`[gemma-memory-intercept] plugin registered; api keys=${Object.keys(api).join(",")}`);

  api.on("message_received", (event, ctx) => {
    // P2.25c route 1 fix: PluginHookMessageContext is { channelId, accountId?, conversationId? }
    // — NO agentId field. Old `ctx.agentId !== "gemma"` always returned (undefined).
    // Now filter by accountId="gemma" (OpenClaw telegram account name for @lisyoen_gemma_bot)
    // + channelId="telegram".
    const accountId = (ctx as { accountId?: string }).accountId;
    const channelId = (ctx as { channelId?: string }).channelId;
    const conversationIdRaw = (ctx as { conversationId?: string }).conversationId;
    // P2.25c route 1 fix (2026-05-24 20:30): ctx.conversationId from telegram is
    // "telegram:56682682" or "telegram:group:-1003821022499" (channel-prefixed).
    // sessionKeyToConversationId() in before_tool_call strips down to just
    // "56682682" / "-1003821022499". Normalize both sides by stripping the
    // leading channel prefix here.
    const conversationId =
      typeof conversationIdRaw === "string"
        ? conversationIdRaw.replace(/^[a-z][a-z0-9_-]*:/i, "").replace(/^group:/, "")
        : undefined;
    if (accountId !== "gemma" || channelId !== "telegram") return;
    counters.messagesSeen++;

    const text = extractUserText(event);
    const matched = text ? looksLikeNaturalMemoRequest(text) : false;
    logger.info(
      `[gemma-memory-intercept] message_received account=${accountId} channel=${channelId} ` +
        `convId=${conversationId ?? ""} textLen=${text?.length ?? 0} matched=${matched} ` +
        `sample="${truncate(text || "", 60).replace(/"/g, '\\"')}"`,
    );
    if (!text) return;
    if (!matched) return;

    counters.naturalMemoMatched++;

    // P2.25c route 1 fix: cache key now (agentId, conversationId).
    // agentId for telegram:gemma account is always "gemma" (see openclaw.json).
    const key = cacheKey("gemma", conversationId);
    userTextCache.set(key, { text, firstToolCallSeen: false, ts: Date.now() });
    pruneCache();

    logger.info(
      `[gemma-memory-intercept] natural-memo cached: key=${key} sample="${truncate(text, 80)}"`,
    );
  });

  api.on("before_tool_call", (event, ctx) => {
    const agentId = (ctx as { agentId?: string }).agentId;
    if (agentId !== "gemma") {
      counters.skippedNotGemma++;
      return;
    }
    counters.toolCallsInspected++;

    // P2.25c route 1 fix: derive conversationId from sessionKey to match
    // the key written by message_received handler.
    const sessionKey = (ctx as { sessionKey?: string }).sessionKey;
    const conversationId = sessionKeyToConversationId(sessionKey);
    const key = cacheKey(agentId, conversationId);
    const entry = userTextCache.get(key);
    logger.info(
      `[gemma-memory-intercept] before_tool_call agent=${agentId} ` +
        `sessionKey=${sessionKey ?? ""} convId=${conversationId ?? ""} key=${key} ` +
        `tool=${String(event.toolName ?? "")} ` +
        `hasCache=${entry ? "yes" : "no"} ` +
        `firstCall=${entry && !entry.firstToolCallSeen ? "yes" : "no"}`,
    );
    if (!entry) {
      counters.skippedNoMatch++;
      return;
    }

    // Only intercept the FIRST toolCall after a matched memo signal.
    if (entry.firstToolCallSeen) {
      counters.skippedNotFirstCall++;
      return;
    }
    entry.firstToolCallSeen = true;

    const forbidden = detectForbiddenCall(event.toolName, event.params);
    if (!forbidden) {
      counters.skippedAllowed++;
      return; // model already chose recall.sh or something benign
    }

    counters.blocked++;
    const blockReason = buildBlockReason(forbidden, entry.text);
    logger.warn(
      `[gemma-memory-intercept] BLOCKED toolCall: key=${key} sessionKey=${sessionKey ?? ""} call=${forbidden}`,
    );

    return { block: true, blockReason };
  });

  return undefined;
};

// ---------------------------------------------------------------------------
// Test surface — pure functions exported for unit tests.
// ---------------------------------------------------------------------------

export const __test__ = {
  looksLikeNaturalMemoRequest,
  detectForbiddenCall,
  buildBlockReason,
  cache: userTextCache,
  counters,
};
