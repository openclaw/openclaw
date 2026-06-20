import { normalizeAgentId } from "../routing/session-key.js";

export const JUDGE_AGENT_ID = "judge";

export const JUDGE_VERDICTS = [
  "APPROVE",
  "REJECT",
  "ESCALATE_TO_HUMAN",
  "REQUEST_MORE_EVIDENCE",
  "SANDBOX_ONLY",
] as const;

export const JUDGE_RISKS = ["low", "medium", "high", "prohibited", "unclear"] as const;

export const JUDGE_PACKET_FIELDS = [
  "claim_or_action",
  "scope",
  "evidence",
  "instructions",
  "risk",
  "requested_verdict",
] as const;

const JUDGE_PACKET_OPTIONAL_FIELDS = ["gate", "evidence_ids", "audit"] as const;
const JUDGE_PACKET_KEYS = [...JUDGE_PACKET_OPTIONAL_FIELDS, ...JUDGE_PACKET_FIELDS] as const;

const HIGH_RISK_TERMS = [
  "credential",
  "secret",
  "token",
  "oauth",
  "browser session",
  "account access",
  "money",
  "trade",
  "purchase",
  "contract",
  "legal",
  "medical",
  "employment",
  "production",
  "deployment",
  "release",
  "public posting",
  "irreversible",
  "governance",
  "agent identity",
  "approval policy",
  "memory canon",
  "self-modification",
  "delete",
  "destructive",
  "database",
  "cloud",
] as const;

const PROHIBITED_TERMS = ["bypass approval", "ignore human", "exfiltrate", "steal token"] as const;

type JudgeVerdictCode = (typeof JUDGE_VERDICTS)[number];
type JudgeRisk = (typeof JUDGE_RISKS)[number];
type JudgePacketField = (typeof JUDGE_PACKET_FIELDS)[number];
type JudgePacketOptionalField = (typeof JUDGE_PACKET_OPTIONAL_FIELDS)[number];
type JudgePacketKey = JudgePacketField | JudgePacketOptionalField;

export type JudgePacket = Partial<Record<JudgePacketKey, string>>;

export type JudgeGateVerdict = {
  verdict: JudgeVerdictCode;
  scope: string;
  evidence: string;
  risk: JudgeRisk;
  reason: string;
  conditions: string;
  evidenceTier: number;
  gate?: string;
};

export type ParsedJudgeVerdict = {
  verdict: JudgeVerdictCode;
  scope: string;
  evidence: string;
  risk: JudgeRisk;
  reason: string;
  conditions: string;
};

export type JudgeCompletionVerdict =
  | ({
      status: "parsed";
    } & ParsedJudgeVerdict)
  | {
      status: "invalid";
      errors: string[];
    };

export type JudgeAuditRecord = {
  timestamp: string;
  gate: string;
  verdict: JudgeVerdictCode;
  risk: JudgeRisk;
  evidenceTier: number;
  scope: string;
  conditions: string;
  model: string;
  runId: string | null;
  requesterAgentId: string | null;
  requesterSessionKey: string | null;
  packetHash: string;
};

export type JudgeHandoffPreflight =
  | {
      status: "not_judge";
      task: string;
    }
  | {
      status: "blocked";
      task: string;
      error: string;
      missingFields: string[];
      detectedFields: string[];
    }
  | {
      status: "ready";
      task: string;
      packet: JudgePacket;
      verdict: JudgeGateVerdict;
      auditRecord: JudgeAuditRecord;
    };

export type JudgeGuardableInternalEvent = {
  judgeVerdict?: JudgeCompletionVerdict;
};

export type JudgeGuardablePayload = {
  text?: string;
  [key: string]: unknown;
};

export type JudgeFinalOutputGuardResult<T extends JudgeGuardablePayload> = {
  payloads: T[];
  changed: boolean;
  blockingVerdict?: JudgeCompletionVerdict;
  audit?: JudgeFinalOutputGuardAudit;
};

export type JudgeFinalOutputGuardAudit = {
  action: "rewrote_final_success_claim";
  verdictStatus: JudgeCompletionVerdict["status"];
  verdict?: JudgeVerdictCode;
  scope?: string;
  risk?: JudgeRisk;
  conditions?: string;
  payloadsChecked: number;
  payloadsRewritten: number;
};

function textOf(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value).map(textOf).join(" ");
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ?? "";
  }
  return "";
}

function isBlockingJudgeVerdict(verdict: JudgeCompletionVerdict | undefined): boolean {
  return Boolean(
    verdict &&
    (verdict.status === "invalid" ||
      verdict.verdict === "REJECT" ||
      verdict.verdict === "ESCALATE_TO_HUMAN" ||
      verdict.verdict === "REQUEST_MORE_EVIDENCE" ||
      verdict.verdict === "SANDBOX_ONLY"),
  );
}

function findBlockingJudgeVerdict(
  internalEvents: readonly JudgeGuardableInternalEvent[] | undefined,
): JudgeCompletionVerdict | undefined {
  return internalEvents?.find((event) => isBlockingJudgeVerdict(event.judgeVerdict))?.judgeVerdict;
}

const FINAL_SUCCESS_CLAIM_RE =
  /\b(approved|complete|completed|done|finished|fixed|verified|validated|safe|passed|ready|working)\b/i;
const NEGATED_OR_BLOCKED_CLAIM_RE =
  /\b(not approved|not complete|not completed|cannot|can't|blocked|rejected|invalid|failed|more evidence|human approval|sandbox only)\b/i;

function containsFinalSuccessClaim(text: string): boolean {
  return FINAL_SUCCESS_CLAIM_RE.test(text) && !NEGATED_OR_BLOCKED_CLAIM_RE.test(text);
}

function formatBlockingJudgeVerdictForUser(verdict: JudgeCompletionVerdict): string {
  if (verdict.status === "invalid") {
    const errorText = verdict.errors.length > 0 ? verdict.errors.join("; ") : "unknown parse error";
    return [
      "Judge did not produce a valid approval verdict.",
      "",
      `VERDICT: INVALID`,
      `REASON: ${errorText}`,
      "CONDITIONS: obtain a valid six-line Judge verdict before marking this complete, approved, verified, or safe.",
    ].join("\n");
  }
  return [
    "Judge did not approve this yet.",
    "",
    `VERDICT: ${verdict.verdict}`,
    `SCOPE: ${verdict.scope}`,
    `EVIDENCE: ${verdict.evidence}`,
    `RISK: ${verdict.risk}`,
    `REASON: ${verdict.reason}`,
    `CONDITIONS: ${verdict.conditions}`,
  ].join("\n");
}

export function applyJudgeVerdictFinalOutputGuard<T extends JudgeGuardablePayload>(params: {
  payloads: readonly T[] | undefined;
  internalEvents?: readonly JudgeGuardableInternalEvent[];
}): JudgeFinalOutputGuardResult<T> {
  const payloads = [...(params.payloads ?? [])];
  const blockingVerdict = findBlockingJudgeVerdict(params.internalEvents);
  if (!blockingVerdict || payloads.length === 0) {
    return { payloads, changed: false, blockingVerdict };
  }

  let payloadsRewritten = 0;
  const guardedText = formatBlockingJudgeVerdictForUser(blockingVerdict);
  const guardedPayloads = payloads.map((payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim() || !containsFinalSuccessClaim(text)) {
      return payload;
    }
    payloadsRewritten += 1;
    return {
      ...payload,
      text: guardedText,
    };
  });
  const changed = payloadsRewritten > 0;

  return {
    payloads: guardedPayloads,
    changed,
    blockingVerdict,
    audit: changed
      ? {
          action: "rewrote_final_success_claim",
          verdictStatus: blockingVerdict.status,
          ...(blockingVerdict.status === "parsed"
            ? {
                verdict: blockingVerdict.verdict,
                scope: blockingVerdict.scope,
                risk: blockingVerdict.risk,
                conditions: blockingVerdict.conditions,
              }
            : {}),
          payloadsChecked: payloads.length,
          payloadsRewritten,
        }
      : undefined,
  };
}

function normalizeRisk(value: unknown): JudgeRisk {
  const risk = typeof value === "string" ? value.toLowerCase() : "";
  return JUDGE_RISKS.find((knownRisk) => knownRisk === risk) ?? "unclear";
}

export function isJudgeAgentId(agentId: string | undefined | null): boolean {
  return normalizeAgentId(agentId) === JUDGE_AGENT_ID;
}

function coercePacketValue(value: unknown): string | undefined {
  const text = textOf(value).trim();
  return text ? text : undefined;
}

function parseJudgePacketJson(text: string): JudgePacket | undefined {
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) {
    return undefined;
  }

  for (
    let start = firstBrace;
    start >= 0 && start < text.length;
    start = text.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            const parsed = JSON.parse(candidate) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              break;
            }
            const packet: JudgePacket = {};
            for (const key of JUDGE_PACKET_KEYS) {
              const value = coercePacketValue((parsed as Record<string, unknown>)[key]);
              if (value) {
                packet[key] = value;
              }
            }
            return Object.keys(packet).length > 0 ? packet : undefined;
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

function parseJudgePacketKeyValues(text: string): JudgePacket {
  const packet: JudgePacket = {};
  const keyPattern = JUDGE_PACKET_KEYS.join("|");
  const regex = new RegExp(
    String.raw`\b(${keyPattern})\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\n;]+))`,
    "gi",
  );
  for (const match of text.matchAll(regex)) {
    const key = match[1]?.toLowerCase() as JudgePacketKey | undefined;
    if (!key || !JUDGE_PACKET_KEYS.includes(key)) {
      continue;
    }
    const value = (match[2] ?? match[3] ?? match[4] ?? "")
      .trim()
      .replace(/[,.]+$/, "")
      .trim();
    if (value) {
      packet[key] = value;
    }
  }
  return packet;
}

export function extractJudgePacketFromText(text: string): JudgePacket {
  return parseJudgePacketJson(text) ?? parseJudgePacketKeyValues(text);
}

export function findMissingJudgePacketFields(packet: JudgePacket): JudgePacketField[] {
  return JUDGE_PACKET_FIELDS.filter((field) => {
    const value = packet[field];
    return value == null || value.trim() === "";
  });
}

export function classifyJudgeRisk(packet: JudgePacket): JudgeRisk {
  const explicit = normalizeRisk(packet.risk);
  if (explicit === "prohibited" || explicit === "high") {
    return explicit;
  }

  const haystack = [packet.claim_or_action, packet.scope, packet.instructions]
    .map(textOf)
    .join(" ")
    .toLowerCase();

  if (PROHIBITED_TERMS.some((term) => haystack.includes(term))) {
    return "prohibited";
  }
  if (HIGH_RISK_TERMS.some((term) => haystack.includes(term))) {
    return "high";
  }
  return explicit;
}

export function detectEvidenceTier(evidence: unknown): number {
  const text = textOf(evidence).toLowerCase();
  if (!text.trim() || text === "none" || text === "insufficient") {
    return 7;
  }
  if (/(caller summary|summary only|claimed|says|reported without)/.test(text)) {
    return 6;
  }
  if (/(inference|assume|assumption|likely|probably)/.test(text)) {
    return 7;
  }
  if (/(memory|recalled|canonical memory|provenance)/.test(text)) {
    return 5;
  }
  if (/(fresh external|web_fetch|web_search|live source|fetched|retrieved)/.test(text)) {
    return 4;
  }
  if (/(test|build|lint|typecheck|format|exited 0|passed|failed|command output)/.test(text)) {
    return 3;
  }
  if (/(source file|config|transcript|log|diff|git status|file read|changed file)/.test(text)) {
    return 2;
  }
  if (/(direct local|direct live|tool output|probe ok|gateway status|runtime status)/.test(text)) {
    return 1;
  }
  return 6;
}

export function detectJudgeContradiction(packet: JudgePacket): boolean {
  const claim = textOf(packet.claim_or_action).toLowerCase();
  const evidence = textOf(packet.evidence).toLowerCase();
  const successClaim = /(complete|finished|fixed|passed|safe|working|deployed)/.test(claim);
  const failedEvidence = /(failed|exited [1-9]\d*|error|blocked|denied|timeout|timed out)/.test(
    evidence,
  );
  return successClaim && failedEvidence;
}

function needsFreshEvidence(packet: JudgePacket): boolean {
  const claim = textOf(packet.claim_or_action).toLowerCase();
  return /\b(latest|current|today|live|now|fresh)\b/.test(claim);
}

function hasFreshEvidence(packet: JudgePacket): boolean {
  const evidence = textOf(packet.evidence).toLowerCase();
  return /(fresh external|web_fetch|web_search|live source|same turn|today|timestamp|fetched)/.test(
    evidence,
  );
}

function summarizeEvidence(evidence: unknown): string {
  const text = textOf(evidence).trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text || "insufficient";
}

export function buildJudgeVerdict(params: {
  verdict: JudgeVerdictCode;
  scope?: string;
  evidence?: string;
  risk?: unknown;
  reason?: string;
  conditions?: string;
  evidenceTier?: number;
  gate?: string;
}): JudgeGateVerdict {
  return {
    verdict: params.verdict,
    scope: params.scope || "unknown",
    evidence: params.evidence || "insufficient",
    risk: normalizeRisk(params.risk),
    reason: params.reason || "No reason supplied.",
    conditions: params.conditions || "none",
    evidenceTier: params.evidenceTier ?? detectEvidenceTier(params.evidence),
    gate: params.gate,
  };
}

export function evaluateJudgePacket(packet: JudgePacket): JudgeGateVerdict {
  const missing = findMissingJudgePacketFields(packet);
  const risk = classifyJudgeRisk(packet);
  const evidenceTier = detectEvidenceTier(packet.evidence);
  const directEnough = evidenceTier <= 4;
  const approvalText = textOf(packet.instructions).toLowerCase();
  const hasHumanApproval = /(human approval present|human approved|approved by human)/.test(
    approvalText,
  );

  if (missing.length > 0) {
    return buildJudgeVerdict({
      verdict: "REQUEST_MORE_EVIDENCE",
      scope: textOf(packet.scope) || "unknown",
      evidence: "insufficient",
      risk,
      reason: `Missing required packet field(s): ${missing.join(", ")}.`,
      conditions: `provide ${missing.join(", ")}`,
      evidenceTier,
      gate: packet.gate,
    });
  }

  if (detectJudgeContradiction(packet)) {
    return buildJudgeVerdict({
      verdict: "REJECT",
      scope: textOf(packet.scope),
      evidence: "contradictory evidence",
      risk,
      reason:
        "The claim asserts success or safety while the evidence contains a failure or blocker.",
      conditions: "resolve the failed evidence and resubmit direct proof",
      evidenceTier,
      gate: packet.gate,
    });
  }

  if (needsFreshEvidence(packet) && !hasFreshEvidence(packet)) {
    return buildJudgeVerdict({
      verdict: "REQUEST_MORE_EVIDENCE",
      scope: textOf(packet.scope),
      evidence: "stale or missing fresh evidence",
      risk,
      reason:
        "Latest/current/live claims require fresh same-turn or clearly dated source evidence.",
      conditions: "provide fresh source evidence",
      evidenceTier,
      gate: packet.gate,
    });
  }

  if ((risk === "high" || risk === "prohibited") && !hasHumanApproval) {
    return buildJudgeVerdict({
      verdict: risk === "prohibited" ? "REJECT" : "ESCALATE_TO_HUMAN",
      scope: textOf(packet.scope),
      evidence: directEnough ? summarizeEvidence(packet.evidence) : "insufficient",
      risk,
      reason:
        risk === "prohibited"
          ? "The packet describes prohibited or approval-bypass behavior."
          : "High-risk action requires explicit Human approval before approval.",
      conditions: risk === "prohibited" ? "blocked" : "obtain explicit Human approval",
      evidenceTier,
      gate: packet.gate,
    });
  }

  if (!directEnough) {
    return buildJudgeVerdict({
      verdict: "REQUEST_MORE_EVIDENCE",
      scope: textOf(packet.scope),
      evidence: "insufficient",
      risk,
      reason: "The packet does not include direct evidence strong enough for approval.",
      conditions: "provide direct tool, source, log, test, build, or fresh source evidence",
      evidenceTier,
      gate: packet.gate,
    });
  }

  const requested = textOf(packet.requested_verdict).toLowerCase();
  if (
    requested.includes("sandbox") ||
    textOf(packet.scope).toLowerCase().includes("sandbox only")
  ) {
    return buildJudgeVerdict({
      verdict: "SANDBOX_ONLY",
      scope: textOf(packet.scope),
      evidence: summarizeEvidence(packet.evidence),
      risk,
      reason:
        "The action has enough evidence for exploration but should not affect real-world state.",
      conditions: "keep execution in sandbox/read-only mode",
      evidenceTier,
      gate: packet.gate,
    });
  }

  return buildJudgeVerdict({
    verdict: "APPROVE",
    scope: textOf(packet.scope),
    evidence: summarizeEvidence(packet.evidence),
    risk,
    reason:
      "The packet is scoped, authorized for its risk level, and supported by direct evidence.",
    conditions: "none",
    evidenceTier,
    gate: packet.gate,
  });
}

export function formatJudgeVerdict(verdict: JudgeGateVerdict): string {
  return [
    `VERDICT: ${verdict.verdict}`,
    `SCOPE: ${verdict.scope}`,
    `EVIDENCE: ${verdict.evidence}`,
    `RISK: ${verdict.risk}`,
    `REASON: ${verdict.reason}`,
    `CONDITIONS: ${verdict.conditions}`,
  ].join("\n");
}

export function parseJudgeVerdict(text: string): {
  ok: boolean;
  errors: string[];
  value?: ParsedJudgeVerdict;
} {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fields = ["VERDICT", "SCOPE", "EVIDENCE", "RISK", "REASON", "CONDITIONS"] as const;
  const errors: string[] = [];
  const parsed: Partial<Record<Lowercase<(typeof fields)[number]>, string>> = {};

  if (lines.length !== fields.length) {
    errors.push(`expected ${fields.length} non-empty lines, got ${lines.length}`);
  }

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const line = lines[index] ?? "";
    const prefix = `${field}: `;
    if (!line.startsWith(prefix)) {
      errors.push(`line ${index + 1} must start with "${prefix}"`);
      continue;
    }
    parsed[field.toLowerCase() as Lowercase<typeof field>] = line.slice(prefix.length).trim();
  }

  if (parsed.verdict && !JUDGE_VERDICTS.includes(parsed.verdict as JudgeVerdictCode)) {
    errors.push(`invalid verdict "${parsed.verdict}"`);
  }
  if (parsed.risk && !JUDGE_RISKS.includes(parsed.risk as JudgeRisk)) {
    errors.push(`invalid risk "${parsed.risk}"`);
  }
  for (const parsedField of fields.map((field) => field.toLowerCase())) {
    if (parsed[parsedField as keyof typeof parsed] === "") {
      errors.push(`${parsedField} must not be empty`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      verdict: parsed.verdict as JudgeVerdictCode,
      scope: parsed.scope ?? "",
      evidence: parsed.evidence ?? "",
      risk: normalizeRisk(parsed.risk),
      reason: parsed.reason ?? "",
      conditions: parsed.conditions ?? "",
    },
  };
}

export function parseJudgeCompletionVerdict(text: string): JudgeCompletionVerdict {
  const parsed = parseJudgeVerdict(text);
  if (!parsed.ok || !parsed.value) {
    return {
      status: "invalid",
      errors: parsed.errors,
    };
  }
  return {
    status: "parsed",
    ...parsed.value,
  };
}

export function createJudgeAuditRecord(
  packet: JudgePacket,
  verdict: JudgeGateVerdict,
  meta: {
    timestamp?: string;
    model?: string;
    runId?: string | null;
    requesterAgentId?: string | null;
    requesterSessionKey?: string | null;
  } = {},
): JudgeAuditRecord {
  return {
    timestamp: meta.timestamp ?? new Date().toISOString(),
    gate: packet.gate ?? verdict.gate ?? "unspecified",
    verdict: verdict.verdict,
    risk: verdict.risk,
    evidenceTier: verdict.evidenceTier,
    scope: verdict.scope,
    conditions: verdict.conditions,
    model: meta.model ?? "unknown",
    runId: meta.runId ?? null,
    requesterAgentId: meta.requesterAgentId ?? null,
    requesterSessionKey: meta.requesterSessionKey ?? null,
    packetHash: stablePacketHash(packet),
  };
}

function stablePacketHash(packet: JudgePacket): string {
  const json = JSON.stringify(packet, Object.keys(packet).toSorted());
  let hash = 0;
  for (let index = 0; index < json.length; index += 1) {
    hash = (hash * 31 + json.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildJudgePreflightTask(params: {
  originalTask: string;
  verdict: JudgeGateVerdict;
  auditRecord: JudgeAuditRecord;
}): string {
  return [
    "Deterministic Judge handoff preflight (runtime-generated; use as packet-quality evidence, not as the final verdict):",
    `packet_schema: ok`,
    `gate: ${params.auditRecord.gate}`,
    `deterministic_verdict: ${params.verdict.verdict}`,
    `risk: ${params.verdict.risk}`,
    `evidence_tier: ${params.verdict.evidenceTier}`,
    `audit: ${JSON.stringify(params.auditRecord)}`,
    "",
    "Deterministic preflight verdict:",
    formatJudgeVerdict(params.verdict),
    "",
    "Judge must now independently issue the required six-line verdict from the original packet.",
    "",
    "Original Judge packet:",
    params.originalTask,
  ].join("\n");
}

export function buildJudgeHandoffPreflight(params: {
  task: string;
  requestedAgentId: string | undefined;
  requesterAgentId?: string | null;
  requesterSessionKey?: string | null;
  model?: string | null;
  runId?: string | null;
  now?: Date;
}): JudgeHandoffPreflight {
  if (!isJudgeAgentId(params.requestedAgentId)) {
    return {
      status: "not_judge",
      task: params.task,
    };
  }

  const packet = extractJudgePacketFromText(params.task);
  const missingFields = findMissingJudgePacketFields(packet);
  const detectedFields = Object.keys(packet).toSorted();

  if (missingFields.length > 0) {
    return {
      status: "blocked",
      task: params.task,
      error: `Judge handoffs require a structured packet before runtime dispatch. Missing required field(s): ${missingFields.join(", ")}.`,
      missingFields,
      detectedFields,
    };
  }

  const verdict = evaluateJudgePacket(packet);
  const auditRecord = createJudgeAuditRecord(packet, verdict, {
    timestamp: (params.now ?? new Date()).toISOString(),
    model: params.model ?? "unknown",
    runId: params.runId ?? null,
    requesterAgentId: params.requesterAgentId ?? null,
    requesterSessionKey: params.requesterSessionKey ?? null,
  });

  return {
    status: "ready",
    task: buildJudgePreflightTask({
      originalTask: params.task,
      verdict,
      auditRecord,
    }),
    packet,
    verdict,
    auditRecord,
  };
}
