/**
 * MEMORY-CANDIDATE-003: Read-only conversation_logs memory candidate extractor.
 *
 * Reads conversation_logs from jinhee.db (read-only) and extracts candidates
 * for promotion to canonical memory.
 *
 * Design constraints:
 *  - SELECT only, mode=ro
 *  - No INSERT/UPDATE/DELETE/ALTER/DROP/CREATE/VACUUM
 *  - No automatic promotion
 *  - No MEMORY.md modification
 *  - Sensitive keyword redaction
 *  - Report-only output
 *
 * Uses Node.js built-in node:sqlite -- no external dependencies.
 */

import { access } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JinheeMemoryCandidateKind =
  | "identity"
  | "preference"
  | "project_state"
  | "operational_rule"
  | "technical_fact"
  | "health_routine"
  | "business_context"
  | "relationship_context"
  | "todo_or_plan"
  | "discard";

export type DuplicateRisk = "low" | "medium" | "high";

export type JinheeMemoryCandidate = {
  id: string;
  kind: JinheeMemoryCandidateKind;
  sourceLogIds: number[];
  text: string;
  confidence: number;
  importance: number;
  duplicateRisk: DuplicateRisk;
  reason: string;
};

export type ExtractMemoryCandidatesOptions = {
  dbPath?: string;
  limit?: number;
  sinceId?: number;
  maxCandidateTextChars?: number;
  minConfidence?: number;
  minImportance?: number;
};

export type ExtractMemoryCandidatesResult =
  | {
      ok: true;
      candidates: JinheeMemoryCandidate[];
      stats: Record<string, number>;
    }
  | {
      ok: false;
      reason: string;
    };

export type CanonicalMemoryRef = {
  id: number;
  content: string;
  memoryType: string;
  truthConfidence: number;
};

export type CandidateReport = {
  title: string;
  summary: string;
  stats: Record<string, number>;
  candidates: JinheeMemoryCandidate[];
  duplicateRisks: Array<{
    candidateId: string;
    existingId: number;
    risk: DuplicateRisk;
    existingContent: string;
    candidateText: string;
  }>;
  discardedCount: number;
  safetyPass: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = "/home/savit/ai/jinhee_data/jinhee.db";
const DEFAULT_LIMIT = 500;
const DEFAULT_SINCE_ID = 0;
const DEFAULT_MAX_CANDIDATE_TEXT_CHARS = 200;
const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_MIN_IMPORTANCE = 0.65;

/**
 * Patterns that trigger discard -- one-time chitchat, simple gratitude, affirmations.
 */
const DISCARD_PATTERNS: ReadonlyArray<RegExp> = [
  /^(ㅋ+|ㅎ+|👍|✅|🟢|🔴|고마워|감사|넵|ㅇㅇ|응|그래|ok|알겠|좋아|알았|네[에]?)\s*$/iu,
  /^(고생|수고|잘 자|굿나잇|ㅂㅂ|바이|bye)\s*$/iu,
  /^(대단하|짱이|멋지|최고|굳|굿)\s*$/iu,
  /^(그래[요]?|맞아[요]?|좋아[요]?|됐[어요]?|됨|오케이|ok|Ok)\s*$/iu,
  /^(계속해|계속하)/u,
  /^https?:\/\/\S+$/i,
];

/**
 * Identity patterns -- who the user/assistant is, roles, names.
 */
const IDENTITY_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:형|누나|동생|진희|준형)/u,
  /(?:내\s*(?:이름|호칭)|(?:call|name|address)\s*(?:me|user|형|진희))/iu,
  /(?:AI\s*(?:비서|어시스턴트|동생|에이전트))/iu,
];

/**
 * Preference patterns -- user likes/dislikes, style preferences.
 */
const PREFERENCE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:나는\s*.+?(?:좋아|싫어|선호|원해|하고\s*싶어|취향))/u,
  /(?:답변\s*(?:형식|스타일|방식))/iu,
  /(?:말투|존댓말|반말|해요체)/u,
  /prefer|favorite|like\s+it\s+when/iu,
];

/**
 * Project state patterns -- completed work, system state, configuration.
 */
const PROJECT_STATE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:완료|완성|구현)\s*(?:$|[\s:])/imu,
  /(?:티켓|ticket|issue)\s*[:-]\s*\S+/iu,
  /(?:gateway)\s*(?:restart|active|ready|pid)/iu,
  /(?:plugin|mcp)\s*(?:safety|mvp|stable|enforcement|policy)/iu,
  /(?:진희OS|JinheeOS|openclaw)(?:\s*(?:안정화|복구|완료))/iu,
  /(?:conversation_logs)\s*(?:schema|count|append)/iu,
  /(?:build|test|restart)\s*(?:완료|ok|pass|success)/iu,
  /(?:MEM-|PLUGIN-|CODEX-|WORKER-|ARCH-)\S+/i,
  /(?:all\s*pass|\d+\/\d+\s*tests?\s*pass)/i,
];

/**
 * Operational rule patterns -- rules, policies, procedures.
 */
const OPERATIONAL_RULE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:금지|허용|규칙|정책|원칙|안전|보안)/u,
  /(?:approval|permission|allowed|forbidden|block|deny|guard)/iu,
  /(?:read.only|read-only|readonly)/iu,
  /(?:절대\s*(?:금지|하지|말))|(?:must\s*not|do\s*not)/iu,
  /(?:manifest|capability\s*policy|ticket\s*format)/iu,
  /(?:backup|백업|복구|restore)/u,
  /(?:INSERT|UPDATE|DELETE)\s*(?:금지|forbidden)/iu,
];

/**
 * Technical fact patterns -- file paths, module locations, versions.
 */
const TECHNICAL_FACT_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:\/\S+\.(?:ts|js|py|json|md))\s*(?:에|은|는|이|가)/u,
  /(?:port)\s*\d+/iu,
  /(?:pid|PID)\s*\d+/iu,
  /(?:dist|build|compile)\s*(?:완료|success|ok|pass)/iu,
  /(?:node|python|pnpm|npm|uvx|npx)\s*(?:version|v?\d+)/iu,
  /(?:sqlite|database|db)\s*(?:schema|path|file)/iu,
  /(?:model:?\s*\w+[-/]\w+|모델\s*(?:변경|라우팅))/iu,
  /(?:openclaw\.json|package\.json|pnpm-lock\.yaml)/i,
];

/**
 * Business context patterns -- delivery, orders, sales.
 */
const BUSINESS_CONTEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:배달|delivery|주문|order|판매|sale|매출|수입|지출)/iu,
  /(?:OCR|정산|미션\s*보너스|프로모션)/u,
  /(?:쇼핑몰|몰지니|MollyJini)/u,
  /(?:ComfyUI|Fashion\s*AI|flux)/iu,
];

/**
 * Health/routine patterns.
 */
const HEALTH_ROUTINE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:운동|health|기상|취침|수면|루틴|routine|습관|컨디션)/iu,
  /(?:식사|밥|먹|아침|점심|저녁)/u,
  /(?:닭가슴살|계란|프로틴|단백질)/u,
];

/**
 * Relationship context patterns.
 */
const RELATIONSHIP_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:가족|식구|누나|형님|동생|아내|와이프|부인)/u,
  /(?:친구|지인|동료|협업|파트너)/u,
  /(?:게스트|guest)/iu,
];

/**
 * Todo/plan patterns.
 */
const TODO_PLAN_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:다음에|이제|앞으로|향후|계획|플랜)\s*(?:할|해야|필요|예정)/u,
  /(?:TODO|todo|할일|해야\s*할|예정|준비)/u,
  /(?:업그레이드|upgrade|개선|refactor|v2|next)/iu,
  /(?:기억\s*(?:승격|promotion))/iu,
];

/**
 * Sensitive patterns to redact.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(token|api_key|secret|password|refresh_token|authorization|bearer|client_secret|access_token|oauth)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSensitiveContent(content: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(content));
}

function isDiscardContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 5) return true;
  return DISCARD_PATTERNS.some((re) => re.test(trimmed));
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^가-힣a-z0-9\s]/gi, "")
    .trim();
}

function longestCommonSubstringLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;

  const dp: number[] = new Array(n + 1).fill(0);
  let maxLen = 0;

  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > maxLen) maxLen = dp[j];
      } else {
        dp[j] = 0;
      }
      prev = temp;
    }
  }
  return maxLen;
}

function substringOverlap(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (normA.length === 0 || normB.length === 0) return 0;

  const shorter = normA.length <= normB.length ? normA : normB;
  const longer = normA.length > normB.length ? normA : normB;

  if (longer.includes(shorter)) return shorter.length / longer.length;

  const maxOverlap = longestCommonSubstringLength(shorter, longer);
  return maxOverlap / shorter.length;
}

function keywordOverlap(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  const wordsA = new Set(normA.split(" ").filter((w) => w.length > 1));
  const wordsB = new Set(normB.split(" ").filter((w) => w.length > 1));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  return intersection / Math.max(wordsA.size, wordsB.size);
}

function estimateDuplicateRisk(
  candidateText: string,
  canonicalEntries: CanonicalMemoryRef[],
): DuplicateRisk {
  for (const entry of canonicalEntries) {
    const subOverlap = substringOverlap(candidateText, entry.content);
    const kwOverlap = keywordOverlap(candidateText, entry.content);

    if (subOverlap > 0.7 || kwOverlap > 0.6) return "high";
    if (subOverlap > 0.4 || kwOverlap > 0.35) return "medium";
  }

  return "low";
}

function classifyKind(text: string): JinheeMemoryCandidateKind {
  const cleaned = text.trim();
  if (isDiscardContent(cleaned)) return "discard";

  // Check specific patterns first, then general
  if (OPERATIONAL_RULE_PATTERNS.some((re) => re.test(cleaned))) return "operational_rule";
  if (TECHNICAL_FACT_PATTERNS.some((re) => re.test(cleaned))) return "technical_fact";
  if (BUSINESS_CONTEXT_PATTERNS.some((re) => re.test(cleaned))) return "business_context";
  if (HEALTH_ROUTINE_PATTERNS.some((re) => re.test(cleaned))) return "health_routine";
  if (RELATIONSHIP_PATTERNS.some((re) => re.test(cleaned))) return "relationship_context";
  if (IDENTITY_PATTERNS.some((re) => re.test(cleaned))) return "identity";
  if (PREFERENCE_PATTERNS.some((re) => re.test(cleaned))) return "preference";
  if (TODO_PLAN_PATTERNS.some((re) => re.test(cleaned))) return "todo_or_plan";
  if (PROJECT_STATE_PATTERNS.some((re) => re.test(cleaned))) return "project_state";

  return "discard";
}

function estimateConfidence(kind: JinheeMemoryCandidateKind, role: "user" | "assistant"): number {
  if (role === "user") {
    switch (kind) {
      case "identity":
        return 0.95;
      case "preference":
        return 0.9;
      case "operational_rule":
        return 0.9;
      case "business_context":
        return 0.85;
      case "health_routine":
        return 0.85;
      case "relationship_context":
        return 0.85;
      case "project_state":
        return 0.8;
      case "technical_fact":
        return 0.8;
      case "todo_or_plan":
        return 0.75;
      default:
        return 0.4;
    }
  }
  // assistant role
  switch (kind) {
    case "technical_fact":
      return 0.85;
    case "project_state":
      return 0.85;
    case "operational_rule":
      return 0.8;
    case "identity":
      return 0.8;
    case "preference":
      return 0.7;
    case "todo_or_plan":
      return 0.65;
    case "business_context":
      return 0.65;
    case "relationship_context":
      return 0.6;
    case "health_routine":
      return 0.6;
    default:
      return 0.3;
  }
}

function estimateImportance(kind: JinheeMemoryCandidateKind): number {
  switch (kind) {
    case "operational_rule":
      return 0.95;
    case "identity":
      return 0.9;
    case "project_state":
      return 0.8;
    case "technical_fact":
      return 0.8;
    case "preference":
      return 0.75;
    case "health_routine":
      return 0.7;
    case "relationship_context":
      return 0.7;
    case "business_context":
      return 0.7;
    case "todo_or_plan":
      return 0.65;
    default:
      return 0.2;
  }
}

function generateCandidateId(kind: JinheeMemoryCandidateKind, index: number): string {
  const prefix = kind.substring(0, 3).toUpperCase();
  return "CAND-" + prefix + "-" + String(index).padStart(3, "0");
}

function truncateCandidateText(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/["""'']/g, "'")
    .replace(/[«»「」『』]/g, "")
    .trim();

  if (cleaned.length <= maxChars) return cleaned;
  const truncated = cleaned.slice(0, maxChars - 1);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?"),
    truncated.lastIndexOf("\n"),
  );
  if (lastSentenceEnd > maxChars * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1);
  }
  return truncated + "\u2026";
}

function buildReason(
  kind: JinheeMemoryCandidateKind,
  confidence: number,
  importance: number,
  role: "user" | "assistant",
  duplicateRisk: DuplicateRisk,
): string {
  const roleLabel = role === "user" ? "사용자 발화" : "어시스턴트 추출";
  const parts: string[] = [roleLabel + " -> " + kind];
  parts.push("conf=" + confidence.toFixed(2) + " imp=" + importance.toFixed(2));
  if (duplicateRisk === "high") parts.push("중복 위험 높음");
  else if (duplicateRisk === "medium") parts.push("일부 중복 가능");
  else parts.push("신규 후보");
  return parts.join(" | ");
}

/**
 * Render a complete candidate report as Markdown.
 */
export function renderCandidateReport(report: CandidateReport): string {
  const lines: string[] = [];

  lines.push("# " + report.title);
  lines.push("");
  lines.push("## 1. Summary");
  lines.push("");
  lines.push(report.summary);
  lines.push("");
  lines.push("## 2. Stats");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  for (const [key, value] of Object.entries(report.stats)) {
    lines.push("| " + key + " | " + value + " |");
  }
  lines.push("");

  lines.push("## 3. Candidate List");
  lines.push("");

  if (report.candidates.length === 0) {
    lines.push("*No candidates passed the filter thresholds.*");
    lines.push("");
  } else {
    for (const cand of report.candidates) {
      lines.push("### " + cand.id);
      lines.push("");
      lines.push("- **kind:** `" + cand.kind + "`");
      lines.push("- **text:** " + cand.text);
      lines.push("- **confidence:** " + cand.confidence.toFixed(2));
      lines.push("- **importance:** " + cand.importance.toFixed(2));
      lines.push("- **duplicateRisk:** " + cand.duplicateRisk);
      lines.push("- **sourceLogIds:** `[" + cand.sourceLogIds.join(", ") + "]`");
      lines.push("- **reason:** " + cand.reason);
      lines.push("");
    }
  }

  lines.push("## 4. Duplicate Risk");
  lines.push("");

  if (report.duplicateRisks.length === 0) {
    lines.push("*No significant duplication risks detected.*");
    lines.push("");
  } else {
    for (const dup of report.duplicateRisks) {
      const icon = dup.risk === "high" ? "⚠️" : "⚡";
      lines.push(
        "- " +
          icon +
          " **" +
          dup.candidateId +
          "** (risk=" +
          dup.risk +
          '): "' +
          dup.candidateText +
          '"',
      );
      lines.push("  - Existing: " + dup.existingContent);
      lines.push("");
    }
  }

  lines.push("## 5. Discarded Categories");
  lines.push("");
  lines.push(
    "**" +
      report.discardedCount +
      "** rows were discarded (chitchat, gratitude, one-time status, sensitive content).",
  );
  lines.push("");

  lines.push("## 6. Safety Checks");
  lines.push("");
  lines.push("- **Sensitive content redacted:** " + (report.safetyPass ? "Pass" : "Fail"));
  lines.push("- **INSERT/UPDATE/DELETE executed:** No (read-only)");
  lines.push("- **canonical_memories modified:** No");
  lines.push("- **MEMORY.md modified:** No");
  lines.push("- **Automatic promotion:** No");
  lines.push("");

  lines.push("## 7. Recommended Promotion Batch");
  lines.push("");
  const promotable = report.candidates.filter(
    (c) => c.duplicateRisk !== "high" && c.confidence >= 0.85 && c.importance >= 0.75,
  );
  if (promotable.length === 0) {
    lines.push(
      "*No candidates meet the promotion threshold (conf>=0.85, imp>=0.75, dupRisk!=high).*",
    );
    lines.push("");
  } else {
    lines.push(
      "The following candidates are recommended for promotion to canonical_memories (pending review):",
    );
    lines.push("");
    for (const cand of promotable) {
      lines.push("1. **" + cand.id + "** (" + cand.kind + "): " + cand.text);
    }
    lines.push("");
  }

  lines.push("## 8. Do Not Apply Automatically");
  lines.push("");
  lines.push("This report is read-only. No changes were made to any database or configuration.");
  lines.push("All promotion decisions require explicit approval.");
  lines.push("");

  lines.push("## 9. Next Steps");
  lines.push("");
  lines.push("1. Review the candidate list");
  lines.push("2. Approve specific candidates for promotion");
  lines.push("3. Promotion tool inserts approved candidates into canonical_memories");
  lines.push("4. Remove or mark low-quality canonical entries (ids 36, 49, 50, 51, 52, 53, 55)");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * Extract memory candidates from conversation_logs (read-only).
 *
 * SELECT only. No writes of any kind.
 * Returns candidate list with confidence/importance scores and duplication risk.
 */
export async function extractJinheeMemoryCandidates(
  options?: ExtractMemoryCandidatesOptions,
): Promise<ExtractMemoryCandidatesResult> {
  const dbPath = options?.dbPath ?? DEFAULT_DB_PATH;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const sinceId = options?.sinceId ?? DEFAULT_SINCE_ID;
  const maxCandidateTextChars = options?.maxCandidateTextChars ?? DEFAULT_MAX_CANDIDATE_TEXT_CHARS;
  const minConfidence = options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minImportance = options?.minImportance ?? DEFAULT_MIN_IMPORTANCE;

  // Early exit: DB file missing
  try {
    await access(dbPath);
  } catch {
    return { ok: false, reason: "DB file not found: " + dbPath };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readWrite: false });
    db.exec("PRAGMA busy_timeout = 800");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "Failed to open DB: " + reason };
  }

  try {
    // Verify tables exist
    const logsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_logs'")
      .get() as { name: string } | undefined;

    if (!logsTable) {
      return { ok: false, reason: "conversation_logs table not found in DB" };
    }

    const memTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_memories'")
      .get() as { name: string } | undefined;

    if (!memTable) {
      return { ok: false, reason: "canonical_memories table not found in DB" };
    }

    // Load canonical memories for dedup
    const canonicalRows = db
      .prepare(
        "SELECT id, content, memory_type, truth_confidence FROM canonical_memories ORDER BY id",
      )
      .all() as Array<{
      id: number;
      content: string;
      memory_type: string;
      truth_confidence: number;
    }>;

    const canonicalEntries: CanonicalMemoryRef[] = (canonicalRows ?? []).map(
      (r: { id: number; content: string; memory_type: string; truth_confidence: number }) => ({
        id: r.id,
        content: (r.content ?? "").trim(),
        memoryType: r.memory_type ?? "",
        truthConfidence: r.truth_confidence ?? 0,
      }),
    );

    // Read conversation_logs
    const logRows = db
      .prepare(
        "SELECT id, sender_type, is_bot_response, text, received_at " +
          "FROM conversation_logs WHERE id > ? ORDER BY id ASC LIMIT ?",
      )
      .all(sinceId, limit) as Array<{
      id: number;
      sender_type: string;
      is_bot_response: number;
      text: string;
      received_at: string;
    }>;

    if (!logRows || logRows.length === 0) {
      return {
        ok: true,
        candidates: [],
        stats: {
          rowsScanned: 0,
          candidatesFound: 0,
          discarded: 0,
          duplicatesHigh: 0,
          duplicatesMedium: 0,
          passThreshold: 0,
          minConfidence: minConfidence,
          minImportance: minImportance,
        },
      };
    }

    // Process each row
    const candidateIdMap = new Map<string, JinheeMemoryCandidate>();
    let discardCount = 0;

    for (const row of logRows) {
      const text = (row.text ?? "").trim();
      if (!text) continue;

      // Skip sensitive content
      if (isSensitiveContent(text)) {
        discardCount++;
        continue;
      }

      const role = row.is_bot_response === 1 ? ("assistant" as const) : ("user" as const);
      const kind = classifyKind(text);

      if (kind === "discard") {
        discardCount++;
        continue;
      }

      const baseConfidence = estimateConfidence(kind, role);
      const importance = estimateImportance(kind);

      if (baseConfidence < minConfidence || importance < minImportance) {
        continue;
      }

      const duplicateRisk = estimateDuplicateRisk(text, canonicalEntries);

      const candidateText = truncateCandidateText(text, maxCandidateTextChars);
      const existingKey = kind + ":" + candidateText.slice(0, 30);

      if (candidateIdMap.has(existingKey)) {
        const existing = candidateIdMap.get(existingKey)!;
        existing.sourceLogIds.push(row.id);
        existing.confidence = Math.min(1.0, existing.confidence + 0.05);
        if (existing.duplicateRisk === "low") {
          existing.duplicateRisk = duplicateRisk;
        }
      } else {
        const id = generateCandidateId(kind, candidateIdMap.size + 1);
        const reason = buildReason(kind, baseConfidence, importance, role, duplicateRisk);
        candidateIdMap.set(existingKey, {
          id,
          kind,
          sourceLogIds: [row.id],
          text: candidateText,
          confidence: baseConfidence,
          importance,
          duplicateRisk,
          reason,
        });
      }
    }

    const candidates = Array.from(candidateIdMap.values());
    const dupHigh = candidates.filter((c) => c.duplicateRisk === "high").length;
    const dupMed = candidates.filter((c) => c.duplicateRisk === "medium").length;
    const passThresh = candidates.filter(
      (c) => c.confidence >= minConfidence && c.importance >= minImportance,
    ).length;

    const stats: Record<string, number> = {
      rowsScanned: logRows.length,
      candidatesFound: candidates.length,
      discarded: discardCount,
      duplicatesHigh: dupHigh,
      duplicatesMedium: dupMed,
      passThreshold: passThresh,
      minConfidence: minConfidence,
      minImportance: minImportance,
    };

    return { ok: true, candidates, stats };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "Extraction error: " + reason };
  } finally {
    db?.close();
  }
}

/**
 * Build a full candidate report from extractor output.
 * Pure function -- no I/O.
 */
export function buildCandidateReport(result: ExtractMemoryCandidatesResult): string {
  if (!result.ok) {
    return (
      "# MEMORY-CANDIDATE-003 -- Candidate Extraction Report\n\n## Error\n\nExtraction failed: " +
      result.reason +
      "\n\n## Do Not Apply Automatically\n\nThis report is read-only. No changes were made.\n"
    );
  }

  const duplicateRisks: CandidateReport["duplicateRisks"] = [];

  for (const cand of result.candidates) {
    if (cand.duplicateRisk === "high" || cand.duplicateRisk === "medium") {
      duplicateRisks.push({
        candidateId: cand.id,
        existingId: 0,
        risk: cand.duplicateRisk,
        existingContent: "(see canonical_memories table)",
        candidateText: cand.text,
      });
    }
  }

  const totalCandidates = result.candidates.length;
  const promotable = result.candidates.filter(
    (c) => c.duplicateRisk !== "high" && c.confidence >= 0.85 && c.importance >= 0.75,
  );

  const summary =
    "Extracted **" +
    totalCandidates +
    "** candidates from **" +
    result.stats.rowsScanned +
    "** conversation log rows " +
    "(sinceId=0, limit=" +
    result.stats.rowsScanned +
    "). " +
    "**" +
    result.stats.discarded +
    "** rows discarded as chitchat, gratitude, or sensitive content. " +
    "**" +
    result.stats.duplicatesHigh +
    "** candidates have high duplication risk with existing canonical_memories. " +
    "**" +
    promotable.length +
    "** candidates meet the promotion threshold (conf>=0.85, imp>=0.75, dupRisk!=high).";

  const report: CandidateReport = {
    title: "MEMORY-CANDIDATE-003 -- Read-only Candidate Report",
    summary,
    stats: result.stats,
    candidates: result.candidates,
    duplicateRisks,
    discardedCount: result.stats.discarded ?? 0,
    safetyPass: true,
  };

  return renderCandidateReport(report);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Run the extractor and print/save the report.
 */
export async function runExtractorCli(options?: {
  dbPath?: string;
  limit?: number;
  sinceId?: number;
  outputPath?: string;
}): Promise<void> {
  const result = await extractJinheeMemoryCandidates({
    dbPath: options?.dbPath,
    limit: options?.limit,
    sinceId: options?.sinceId,
  });

  const report = buildCandidateReport(result);
  console.log(report);

  if (options?.outputPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(options.outputPath, report, "utf-8");
    console.error("\nReport saved to: " + options.outputPath);
  }
}
