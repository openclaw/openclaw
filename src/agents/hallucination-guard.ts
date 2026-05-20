/**
 * Hallucination guard for gemma-style local models that fabricate tool
 * usage in plain text. P2.14 (gemma-memory follow-up).
 *
 * Background: 2026-05-20 ClaudeU TDLib verification reproduced two
 * patterns that earlier fixes (P2.10 TOOLS.md hardening, P2.11
 * sentinel sanitize, P2.12 tool-loop block) did not address:
 *
 *   user "황선아라고 알지?"
 *   → assistant "메모리를 검색해 봤는데… 기억 속에 구체적인 정보가 없어…"
 *   → OpenClaw log: 0 tool_use blocks, 0 memory.sh by-person calls
 *
 * The text claims a tool was called but the agent never actually issued
 * a tool_use. P2.10 study concluded that TOOLS.md cheat-sheet text
 * hardening cannot steer Gemma 4 26B sampling away from this failure —
 * only a runtime code guard can.
 *
 * Trigger (AND, all four must hold):
 *   1. agent in OPENCLAW_HALLUCINATION_GUARD_AGENTS whitelist
 *      (default: "gemma")
 *   2. last user message matches a Korean person-query pattern (P1-P5)
 *      and the captured name is not in the blacklist
 *   3. last assistant message is text-only (content has no tool_use
 *      blocks)
 *   4. assistant text matches a false-tool-report pattern (F1-F8)
 *
 * On trigger, the guard re-runs the workspace memory.sh by-person
 * script and posts a corrective follow-up message on the same telegram
 * chat as a fire-and-forget side channel. The original (false) message
 * has already been delivered — the correction follows. This is an
 * MVP integration constraint: the plugin agent_end hook fires after
 * delivery and the message_sending hook ctx lacks agentId
 * (deliver.ts:415 metadata omission). See proposals/gemma-memory.md
 * §12 for the full design and §12.5 for the upgrade path.
 *
 * The guard is gemma-scoped by default and has no effect on other
 * agents. It is disabled with OPENCLAW_HALLUCINATION_GUARD_ENABLED=0.
 */

import { spawn } from "node:child_process";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/hallucination-guard");

// ---------------------------------------------------------------------------
// Configuration (env knobs follow the P2.12 pattern)
// ---------------------------------------------------------------------------

const ENV_ENABLED = "OPENCLAW_HALLUCINATION_GUARD_ENABLED";
const ENV_AGENTS = "OPENCLAW_HALLUCINATION_GUARD_AGENTS";
const ENV_TIMEOUT_MS = "OPENCLAW_HALLUCINATION_GUARD_TIMEOUT_MS";
const ENV_MEMORY_SH = "OPENCLAW_HALLUCINATION_GUARD_MEMORY_SH";
const ENV_FALLBACK_CHAT_ID = "OPENCLAW_HALLUCINATION_GUARD_CHAT_ID";
const ENV_FALLBACK_API = "OPENCLAW_HALLUCINATION_GUARD_API";
const ENV_LOG_LEVEL = "OPENCLAW_HALLUCINATION_GUARD_LOG_LEVEL";

const DEFAULT_AGENTS = "gemma";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MEMORY_SH = "/home/lisyoen/.openclaw/agents/gemma/workspace/scripts/memory.sh";
const DEFAULT_FALLBACK_API = "http://127.0.0.1:9087/api/send";

export type HallucinationGuardConfig = {
  enabled: boolean;
  agents: ReadonlySet<string>;
  timeoutMs: number;
  memoryShPath: string;
  fallbackChatId: string | null;
  fallbackApi: string;
  logLevel: "debug" | "info" | "warn";
};

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): HallucinationGuardConfig {
  const enabledRaw = (env[ENV_ENABLED] ?? "1").trim().toLowerCase();
  const enabled = enabledRaw !== "0" && enabledRaw !== "false" && enabledRaw !== "no";
  const agentsRaw = (env[ENV_AGENTS] ?? DEFAULT_AGENTS).trim();
  const agents = new Set(
    agentsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  const timeoutRaw = Number.parseInt(env[ENV_TIMEOUT_MS] ?? "", 10);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS;
  const memoryShPath = (env[ENV_MEMORY_SH] ?? DEFAULT_MEMORY_SH).trim();
  const fallbackChatIdRaw = (env[ENV_FALLBACK_CHAT_ID] ?? "").trim();
  const fallbackChatId = fallbackChatIdRaw.length > 0 ? fallbackChatIdRaw : null;
  const fallbackApi = (env[ENV_FALLBACK_API] ?? DEFAULT_FALLBACK_API).trim();
  const logLevelRaw = (env[ENV_LOG_LEVEL] ?? "info").trim().toLowerCase();
  const logLevel = logLevelRaw === "debug" || logLevelRaw === "warn" ? logLevelRaw : "info";
  return {
    enabled,
    agents,
    timeoutMs,
    memoryShPath,
    fallbackChatId,
    fallbackApi,
    logLevel,
  };
}

// ---------------------------------------------------------------------------
// Pure pattern matchers
// ---------------------------------------------------------------------------

/**
 * Korean person-query patterns (P1-P5). Match a 2-5 hangul-char name
 * embedded in question forms. Names captured here are still subject to
 * the blacklist below.
 *
 * MVP scope (D15): hangul only. English / hanja / mixed names are out
 * of scope for P2.14 — no hallucination cases were observed for those
 * in the 2026-05-20 reproduction.
 */
const PERSON_QUERY_PATTERNS: ReadonlyArray<RegExp> = [
  // P1: "<이름>(이)? (가|는|을|를)? 누구(야|입니까|예요|니|냐)"
  /([가-힣]{2,5}?)(?:이)?\s*(?:가|는|은|을|를)?\s*누구(?:야|입니까|예요|니|냐)/,
  // P2: "<이름>(이라고|라고)? 알(아|지|아요|아\?)"
  /([가-힣]{2,5}?)(?:이라고|라고)?\s*알(?:아|지|아요)\??/,
  // P3: "<이름>(이|가)? 어떤 사람"
  /([가-힣]{2,5}?)(?:이|가)?\s*어떤\s*사람/,
  // P4: "<이름> (이|에|을|를|에 대해|에 관해) (기억|아는|알려)"
  /([가-힣]{2,5}?)(?:이|에|을|를|에\s*대해|에\s*관해)\s*(?:기억|아는|알려)/,
  // P5: "<이름>(은|는) (누구|어떤)"
  /([가-힣]{2,5}?)(?:은|는)\s*(?:누구|어떤)/,
];

/**
 * Hangul tokens that fit the [가-힣]{2,5}? regex but are obviously not
 * person names. Filtering these here avoids false positives on common
 * time/pronoun phrases.
 */
const PERSON_NAME_BLACKLIST: ReadonlySet<string> = new Set([
  "오늘",
  "내일",
  "어제",
  "그제",
  "모레",
  "이번",
  "저번",
  "다음",
  "지난",
  "요즘",
  "나는",
  "내가",
  "우리",
  "우리는",
  "너는",
  "네가",
]);

/**
 * False-tool-report patterns (F1-F8). Match phrases the model uses to
 * *claim* a memory or filesystem lookup happened. Any single match
 * suffices.
 */
const FALSE_TOOL_REPORT_PATTERNS: ReadonlyArray<RegExp> = [
  // F1: 메모리(를|에서)? (검색|찾아|뒤져|훑어|확인)
  /메모리(?:를|에서)?\s*(?:검색|찾아|뒤져|훑어|확인)/,
  // F2: (검색|찾아|뒤져|훑어|확인)(해|봤|을)
  /(?:검색|찾아|뒤져|훑어|확인)(?:해|봤|을)/,
  // F3: 기억(이|에)? 없
  /기억(?:이|에)?\s*없/,
  // F4: 기록(이|에)? 없
  /기록(?:이|에)?\s*없/,
  // F5: 정보(가|는|에)? 없
  /정보(?:가|는|에)?\s*없/,
  // F6: memory_(search|lookup|get|find)
  /memory_(?:search|lookup|get|find)/,
  // F7: 5/17 박제 환각 키워드
  /Snippet\s*내용을?\s*바탕으로/,
  // F8: (파일|디렉토리|폴더)(을|를|에서)? (찾|확인|검색)(아|해)? 봤
  /(?:파일|디렉토리|폴더)(?:을|를|에서)?\s*(?:찾|확인|검색)(?:아|해)?\s*봤/,
];

export type PersonNameMatch = {
  name: string;
  patternIndex: number;
};

/**
 * Extract the first plausible person name from a user message.
 * Returns null when no pattern matches or when the captured token is
 * in the blacklist.
 */
export function extractPersonName(text: string): PersonNameMatch | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  for (let i = 0; i < PERSON_QUERY_PATTERNS.length; i++) {
    const pattern = PERSON_QUERY_PATTERNS[i];
    if (!pattern) {
      continue;
    }
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    const captured = match[1];
    if (typeof captured !== "string" || captured.length === 0) {
      continue;
    }
    if (PERSON_NAME_BLACKLIST.has(captured)) {
      // Captured token is blacklisted — keep scanning later patterns.
      // The same text may legitimately contain a different name elsewhere.
      continue;
    }
    return { name: captured, patternIndex: i };
  }
  return null;
}

/**
 * Returns true when any false-tool-report pattern matches.
 */
/**
 * Broad-negation fallback (F9). The narrow F1-F8 patterns assume the
 * negation sits directly after the subject; the model frequently pads
 * with adverbs ("정보가 *전혀* 없어", "복구되지 *않아서*") or splits
 * the subject and the negation across a longer clause. F9 fires when
 * the same sentence contains BOTH a tool/system mention AND a negation
 * keyword — captured by these two complementary regexes.
 */
const FALSE_TOOL_REPORT_NEGATION =
  /없어|없네|없습니다|없죠|모르겠|모릅니다|모른다|되지\s*않|되지\s*못|안\s*돼/;
const FALSE_TOOL_REPORT_SUBJECT =
  /메모리|기억|기록|정보|파일|디렉토리|폴더|MD|시스템|기능|데이터베이스|업데이트|학습|기록이|기록은|기록도/;

export function detectFalseToolReport(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  for (const pattern of FALSE_TOOL_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  // F9: any sentence containing both a tool/system subject keyword
  // and a negation keyword. Less precise than F1-F8 but catches the
  // padded-adverb wordings observed on 2026-05-20.
  if (FALSE_TOOL_REPORT_NEGATION.test(text) && FALSE_TOOL_REPORT_SUBJECT.test(text)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Message extraction (defensive — the upstream payload is `unknown`)
// ---------------------------------------------------------------------------

type ContentBlock = { type?: unknown; text?: unknown } & Record<string, unknown>;
type MessageLike = {
  role?: unknown;
  content?: unknown;
} & Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asContentArray(message: unknown): ContentBlock[] {
  if (!isPlainObject(message)) {
    return [];
  }
  const content = (message as MessageLike).content;
  if (Array.isArray(content)) {
    return content.filter((c): c is ContentBlock => isPlainObject(c));
  }
  return [];
}

/**
 * Returns true when the message has at least one tool_use content
 * block. A text-only assistant message returns false.
 */
export function hasToolUse(message: unknown): boolean {
  for (const block of asContentArray(message)) {
    if (block.type === "tool_use") {
      return true;
    }
  }
  return false;
}

/**
 * Concatenate all text-block bodies on a message. String-content
 * messages (legacy shape) are returned as-is.
 */
export function getMessageText(message: unknown): string {
  if (!isPlainObject(message)) {
    return "";
  }
  const content = (message as MessageLike).content;
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const block of asContentArray(message)) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Find the last user message in a transcript snapshot and return its
 * concatenated text content. Returns empty string when no user
 * message is present.
 */
export function getLastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isPlainObject(m) && (m as MessageLike).role === "user") {
      return getMessageText(m);
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Trigger check
// ---------------------------------------------------------------------------

export type GuardCheckResult =
  | { triggered: false; reason: string }
  | { triggered: true; personName: string; patternIndex: number };

export type CheckGuardInput = {
  agentId: string | undefined;
  messages: unknown;
  lastAssistant: unknown;
  config: HallucinationGuardConfig;
};

export function checkHallucinationGuard(input: CheckGuardInput): GuardCheckResult {
  const { agentId, messages, lastAssistant, config } = input;

  if (!config.enabled) {
    return { triggered: false, reason: "disabled" };
  }
  if (typeof agentId !== "string" || agentId.length === 0) {
    return { triggered: false, reason: "no-agent-id" };
  }
  if (!config.agents.has(agentId)) {
    return { triggered: false, reason: "agent-not-in-whitelist" };
  }

  const userText = getLastUserText(messages);
  if (userText.length === 0) {
    return { triggered: false, reason: "no-user-message" };
  }
  const personMatch = extractPersonName(userText);
  if (!personMatch) {
    return { triggered: false, reason: "no-person-pattern" };
  }

  if (hasToolUse(lastAssistant)) {
    return { triggered: false, reason: "has-tool-use" };
  }

  const assistantText = getMessageText(lastAssistant);
  if (!detectFalseToolReport(assistantText)) {
    return { triggered: false, reason: "no-false-report" };
  }

  return {
    triggered: true,
    personName: personMatch.name,
    patternIndex: personMatch.patternIndex,
  };
}

// ---------------------------------------------------------------------------
// memory.sh runner with hard timeout
// ---------------------------------------------------------------------------

export type MemoryShResult =
  | { status: "ok"; matches: number; stdout: string }
  | { status: "failed"; reason: string; stdout: string }
  | { status: "error"; errorMessage: string };

export type RunMemoryShDeps = {
  /** Override the spawner for tests. Defaults to node:child_process spawn. */
  spawnFn?: typeof spawn;
};

/**
 * Run `memory.sh by-person <name>` with a hard timeout. Parses the
 * trailing RESULT line for `matches: <N>` to classify ok vs failed.
 */
export async function runMemorySh(
  scriptPath: string,
  personName: string,
  timeoutMs: number,
  deps: RunMemoryShDeps = {},
): Promise<MemoryShResult> {
  const spawner = deps.spawnFn ?? spawn;
  return new Promise<MemoryShResult>((resolve) => {
    let settled = false;
    const child = spawner("bash", [scriptPath, "by-person", personName], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const settle = (result: MemoryShResult) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — child already exited
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ status: "error", errorMessage: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      settle({ status: "error", errorMessage: String(err) });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle({
          status: "error",
          errorMessage: `exit ${code ?? "null"}: ${stderr.slice(0, 200)}`,
        });
        return;
      }
      const matchesMatch = /RESULT:\s*OK[^\n]*matches:\s*(\d+)/i.exec(stdout);
      if (matchesMatch && matchesMatch[1]) {
        const matches = Number.parseInt(matchesMatch[1], 10);
        if (matches > 0) {
          settle({ status: "ok", matches, stdout });
          return;
        }
        settle({ status: "failed", reason: "matches=0", stdout });
        return;
      }
      // No RESULT line — treat as failed but keep stdout for log.
      settle({ status: "failed", reason: "no-result-line", stdout });
    });
  });
}

// ---------------------------------------------------------------------------
// Telegram fallback delivery (POST /api/send)
// ---------------------------------------------------------------------------

export type SendFallbackResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; errorMessage: string };

export type SendFallbackDeps = {
  fetchFn?: typeof fetch;
};

export async function sendFallbackMessage(
  apiUrl: string,
  chatId: string,
  text: string,
  timeoutMs: number,
  deps: SendFallbackDeps = {},
): Promise<SendFallbackResult> {
  const fetcher = deps.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    return {
      ok: false,
      status: res.status,
      errorMessage: `http ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Inline guard entry point — called from attempt.ts after agent_end hook
// ---------------------------------------------------------------------------

export type RunGuardInlineInput = {
  agentId: string | undefined;
  messages: unknown;
  lastAssistant: unknown;
  /** Override env config (tests). */
  config?: HallucinationGuardConfig;
  /** Override env source (tests). */
  env?: NodeJS.ProcessEnv;
  /** Test seam for memory.sh. */
  runMemoryShFn?: typeof runMemorySh;
  /** Test seam for telegram POST. */
  sendFallbackFn?: typeof sendFallbackMessage;
};

export type RunGuardInlineResult = {
  triggered: boolean;
  reason: string;
  memoryStatus?: MemoryShResult["status"];
  fallbackSent?: boolean;
};

/**
 * Build the corrective message body sent to the user. Kept as a pure
 * function so the format is unit-testable.
 */
export function buildCorrectionText(personName: string, memoryResult: MemoryShResult): string {
  if (memoryResult.status === "ok") {
    const stdout = memoryResult.stdout.trim();
    // Trim stdout to keep telegram message size reasonable.
    const trimmed = stdout.length > 3500 ? `${stdout.slice(0, 3500)}\n…(truncated)` : stdout;
    return `(가드) 직전 답변은 도구 호출 없이 작성됐어. memory.sh 로 ${personName} 다시 확인한 결과:\n\n${trimmed}`;
  }
  if (memoryResult.status === "failed") {
    return `(가드) memory/ 에서 '${personName}' 관련 일지 못 찾았어. people/${personName}.md 인물 카드도 확인할까? (정확한 이름 알려줘)`;
  }
  return `(가드) ${personName} 관련 메모리 조회 실패: ${memoryResult.errorMessage}`;
}

export async function runHallucinationGuardInline(
  input: RunGuardInlineInput,
): Promise<RunGuardInlineResult> {
  const config = input.config ?? readEnvConfig(input.env);

  const check = checkHallucinationGuard({
    agentId: input.agentId,
    messages: input.messages,
    lastAssistant: input.lastAssistant,
    config,
  });

  if (!check.triggered) {
    if (config.logLevel === "debug") {
      log.debug(`hallucination-guard skipped: ${check.reason}`);
    }
    return { triggered: false, reason: check.reason };
  }

  log.info(
    `hallucination-guard triggered: agent=${input.agentId ?? "?"} person=${check.personName} pattern=P${check.patternIndex + 1}`,
  );

  const runner = input.runMemoryShFn ?? runMemorySh;
  const memoryResult = await runner(config.memoryShPath, check.personName, config.timeoutMs);

  log.info(
    `hallucination-guard memory.sh result: status=${memoryResult.status}` +
      (memoryResult.status === "ok" ? ` matches=${memoryResult.matches}` : "") +
      (memoryResult.status === "failed" ? ` reason=${memoryResult.reason}` : "") +
      (memoryResult.status === "error" ? ` error=${memoryResult.errorMessage}` : ""),
  );

  if (!config.fallbackChatId) {
    log.warn("hallucination-guard fallback skipped: OPENCLAW_HALLUCINATION_GUARD_CHAT_ID not set");
    return {
      triggered: true,
      reason: "triggered",
      memoryStatus: memoryResult.status,
      fallbackSent: false,
    };
  }

  const text = buildCorrectionText(check.personName, memoryResult);
  const sender = input.sendFallbackFn ?? sendFallbackMessage;
  const sendResult = await sender(
    config.fallbackApi,
    config.fallbackChatId,
    text,
    config.timeoutMs,
  );

  if (sendResult.ok) {
    log.info(`hallucination-guard fallback delivered (status=${sendResult.status})`);
  } else {
    log.warn(
      `hallucination-guard fallback failed: status=${sendResult.status ?? "null"} err=${sendResult.errorMessage ?? ""}`,
    );
  }

  return {
    triggered: true,
    reason: "triggered",
    memoryStatus: memoryResult.status,
    fallbackSent: sendResult.ok,
  };
}
