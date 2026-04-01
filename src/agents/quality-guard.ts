import crypto from "node:crypto";
import { normalizeReplyPayload } from "../auto-reply/reply/normalize-reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptPath } from "../config/sessions/paths.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveAgentDir,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import type { EmbeddedPiRunResult } from "./pi-embedded.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "./skills.js";
import type { SkillSnapshot } from "./skills.js";
import { getSkillsSnapshotVersion } from "./skills/refresh.js";

const log = createSubsystemLogger("agents/quality-guard");

export const CHIEF_AGENT_ID = "chief";
export const QUALITY_GUARD_AGENT_ID = "quality_guard";
const MAX_REVIEW_ROUNDS = 2;

type QualityGuardVerdict = "approve" | "revise" | "block";
type QualityGuardSeverity = "low" | "medium" | "high";

export type QualityGuardReviewContract = {
  verdict: QualityGuardVerdict;
  severity: QualityGuardSeverity;
  findings: string[];
  missing_evidence: string[];
  scope_or_logic_issues: string[];
  required_revisions: string[];
  paperclip_update_safe: boolean;
  can_finalize: boolean;
};

export type ChiefQualityGuardParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  originalPrompt: string;
  result: EmbeddedPiRunResult;
  timeoutMs: number;
  runId: string;
  workspaceDir: string;
  provider?: string;
  model?: string;
  chiefSkillsSnapshot?: SkillSnapshot;
  successCriteria?: string;
  evidenceSummary?: string[];
};

function toNormalizedTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function normalizeVerdict(value: unknown): QualityGuardVerdict {
  if (value === "approve" || value === "revise" || value === "block") {
    return value;
  }
  return "block";
}

function normalizeSeverity(value: unknown): QualityGuardSeverity {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "high";
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = (fenced ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}

export function parseQualityGuardReview(raw: string): QualityGuardReviewContract {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return {
      verdict: "block",
      severity: "high",
      findings: ["quality_guard returned an invalid review contract."],
      missing_evidence: [],
      scope_or_logic_issues: ["Review output was not valid JSON."],
      required_revisions: ["Retry the final response review with a valid structured contract."],
      paperclip_update_safe: false,
      can_finalize: false,
    };
  }
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const verdict = normalizeVerdict(parsed.verdict);
    const severity = normalizeSeverity(parsed.severity);
    const paperclipUpdateSafe = parsed.paperclip_update_safe === true;
    const canFinalize =
      parsed.can_finalize === true && verdict === "approve" && paperclipUpdateSafe !== false;
    return {
      verdict,
      severity,
      findings: toNormalizedTextArray(parsed.findings),
      missing_evidence: toNormalizedTextArray(parsed.missing_evidence),
      scope_or_logic_issues: toNormalizedTextArray(parsed.scope_or_logic_issues),
      required_revisions: toNormalizedTextArray(parsed.required_revisions),
      paperclip_update_safe: paperclipUpdateSafe,
      can_finalize: canFinalize,
    };
  } catch (error) {
    return {
      verdict: "block",
      severity: "high",
      findings: ["quality_guard returned malformed JSON."],
      missing_evidence: [],
      scope_or_logic_issues: [
        error instanceof Error ? error.message : "Unable to parse quality_guard review.",
      ],
      required_revisions: ["Retry the final response review with valid JSON."],
      paperclip_update_safe: false,
      can_finalize: false,
    };
  }
}

function collectVisibleReplyText(payloads?: ReplyPayload[]): string {
  return (payloads ?? [])
    .filter((payload) => payload?.isReasoning !== true && payload?.isError !== true)
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function collectVisibleMediaUrls(payloads?: ReplyPayload[]): string[] {
  const urls = new Set<string>();
  for (const payload of payloads ?? []) {
    const values = [payload.mediaUrl, ...(payload.mediaUrls ?? [])];
    for (const value of values) {
      const trimmed = value?.trim();
      if (trimmed) {
        urls.add(trimmed);
      }
    }
  }
  return Array.from(urls);
}

const INTERNAL_REVIEW_LEAK_PATTERNS = [
  /\bquality_guard\b/i,
  /\bfinal review gate\b/i,
  /\binternal review\b/i,
  /\breview round\b/i,
  /\brevision round\b/i,
  /\bpaperclip_update_safe\b/i,
  /\bcan_finalize\b/i,
  /\bscope_or_logic_issues\b/i,
  /\brequired_revisions\b/i,
  /^\s*what still needs to be addressed\b/i,
  /^\s*i can'?t finalize this safely yet\b/i,
  /^\s*the draft\b/i,
  /^\s*the candidate\b/i,
  /^\s*candidate\b/i,
];

const USER_SAFE_BLOCK_FALLBACK_BULLETS = [
  "- Mình cần thêm bằng chứng hoặc xác minh trực tiếp trước khi có thể chốt an toàn.",
  "- Câu trả lời hiện tại vẫn chưa đủ chắc để gửi ra như kết luận cuối.",
];

function containsInternalReviewLeak(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  return INTERNAL_REVIEW_LEAK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function sanitizeUserFacingBlockedReasons(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !containsInternalReviewLeak(value))
    .slice(0, 5);
}

const TRIVIAL_REPLY_PATTERNS = [
  /^(received|got it|acknowledged|noted|understood)\b/i,
  /^(i('| a)?m on it|working on it|looking into it)\b/i,
  /^(da nhan|da ro|dang xu ly)\b/i,
  /^(đã nhận|đã rõ|đang xử lý|mình đã nhận)\b/i,
  /^(need more information|i need more information|please share|could you clarify)\b/i,
  /^(cần thêm thông tin|bạn có thể làm rõ|cho mình thêm)\b/i,
];

export function isLikelyTrivialChiefReply(params: {
  originalPrompt: string;
  replyText: string;
}): boolean {
  const text = params.replyText.trim();
  if (!text) {
    return true;
  }
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasStructure =
    /```/.test(text) ||
    /^\s*[-*]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /^\s*\*\*[^*]+\*\*/m.test(text);
  const asksClarification = text.endsWith("?") && lineCount <= 2 && wordCount <= 40;
  const looksTrivial = TRIVIAL_REPLY_PATTERNS.some((pattern) => pattern.test(text));
  if (hasStructure) {
    return false;
  }
  if (text.length <= 220 && lineCount <= 3 && wordCount <= 40 && (looksTrivial || asksClarification)) {
    return true;
  }
  return false;
}

export function shouldRequireChiefQualityGuardReview(params: {
  agentId?: string;
  originalPrompt: string;
  replyText: string;
}): boolean {
  if ((params.agentId ?? "").trim().toLowerCase() !== CHIEF_AGENT_ID) {
    return false;
  }
  const text = params.replyText.trim();
  if (!text) {
    return false;
  }
  if (isLikelyTrivialChiefReply(params)) {
    return false;
  }
  if (text.length >= 240) {
    return true;
  }
  if (/```/.test(text) || /^\s*[-*]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)) {
    return true;
  }
  const combined = `${params.originalPrompt}\n${text}`;
  if (
    /\b(plan|implement|review|audit|policy|workflow|promotion|deploy|release|forecast|finance|paperclip|agent|config|runtime|library|project|child issue)\b/i.test(
      combined,
    )
  ) {
    return true;
  }
  return text.split(/\n{2,}/).filter(Boolean).length > 1;
}

function buildQualityGuardPrompt(params: {
  originalPrompt: string;
  candidateText: string;
  successCriteria?: string;
  evidenceSummary?: string[];
  round: number;
}): string {
  const evidenceLines =
    Array.isArray(params.evidenceSummary) && params.evidenceSummary.length > 0
      ? params.evidenceSummary.map((item) => `- ${item}`).join("\n")
      : "- No explicit evidence summary was provided.";
  return [
    "You are quality_guard, the mandatory final executive skeptic for chief.",
    "Review the candidate final response and return ONLY one JSON object.",
    'JSON schema: {"verdict":"approve|revise|block","severity":"low|medium|high","findings":[],"missing_evidence":[],"scope_or_logic_issues":[],"required_revisions":[],"paperclip_update_safe":true,"can_finalize":true}',
    "Approve only when the candidate is internally consistent, evidence-sufficient for the request, within scope, and safe to finalize.",
    "Use revise when the draft is repairable in one more pass. Use block when the draft is materially incomplete, contradictory, overclaiming, unsafe, or not ready to finalize.",
    "For trivial receipt-only or clarification-only replies, approve with empty arrays.",
    "Use the same end-user language as the original request.",
    "Do not include internal role names, gate names, JSON field names, or hidden workflow wording inside the human-readable arrays.",
    `Review round: ${String(params.round)}`,
    "",
    "<original_request>",
    params.originalPrompt.trim(),
    "</original_request>",
    "",
    "<success_criteria>",
    (params.successCriteria?.trim() || "(same as the original request and current goal)").trim(),
    "</success_criteria>",
    "",
    "<evidence_summary>",
    evidenceLines,
    "</evidence_summary>",
    "",
    "<candidate_final_response>",
    params.candidateText.trim(),
    "</candidate_final_response>",
  ].join("\n");
}

function buildChiefRevisionPrompt(params: {
  originalPrompt: string;
  candidateText: string;
  review: QualityGuardReviewContract;
  round: number;
}): string {
  const required = [
    ...params.review.findings,
    ...params.review.missing_evidence,
    ...params.review.scope_or_logic_issues,
    ...params.review.required_revisions,
  ]
    .filter(Boolean)
    .slice(0, 12);
  const requiredLines =
    required.length > 0 ? required.map((item) => `- ${item}`).join("\n") : "- Strengthen the final response so it is safe to finalize.";
  return [
    "Revise the candidate final response so it passes the mandatory final review gate.",
    "Return ONLY the revised final response for the end user.",
    "Do not mention quality_guard, internal review, hidden process, or the fact that this is a revision.",
    "Keep the same end-user language as the original request.",
    `Revision round: ${String(params.round)}`,
    "",
    "<original_request>",
    params.originalPrompt.trim(),
    "</original_request>",
    "",
    "<previous_draft>",
    params.candidateText.trim(),
    "</previous_draft>",
    "",
    "<required_revisions>",
    requiredLines,
    "</required_revisions>",
  ].join("\n");
}

export function buildBlockedFinalizationMessage(params: {
  review: QualityGuardReviewContract;
}): string {
  const reasons = sanitizeUserFacingBlockedReasons([
    ...params.review.findings,
    ...params.review.missing_evidence,
    ...params.review.scope_or_logic_issues,
    ...params.review.required_revisions,
  ]);
  const bullets =
    reasons.length > 0
      ? reasons.map((entry) => `- ${entry}`).join("\n")
      : USER_SAFE_BLOCK_FALLBACK_BULLETS.join("\n");
  return [
    "Mình chưa thể chốt an toàn ở thời điểm này.",
    "",
    "Những gì còn cần xử lý:",
    bullets,
  ].join("\n");
}

async function runQualityGuardReview(params: {
  cfg: OpenClawConfig;
  originalPrompt: string;
  candidateText: string;
  successCriteria?: string;
  evidenceSummary?: string[];
  timeoutMs: number;
  runId: string;
  round: number;
}): Promise<QualityGuardReviewContract> {
  const sessionId = crypto.randomUUID();
  const sessionKey = `agent:${QUALITY_GUARD_AGENT_ID}:review-${sessionId}`;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, QUALITY_GUARD_AGENT_ID);
  const agentDir = resolveAgentDir(params.cfg, QUALITY_GUARD_AGENT_ID);
  const modelRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: QUALITY_GUARD_AGENT_ID,
  });
  const skillFilter = resolveAgentSkillsFilter(params.cfg, QUALITY_GUARD_AGENT_ID);
  const skillsSnapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
    config: params.cfg,
    skillFilter,
    eligibility: { remote: getRemoteSkillEligibility() },
    snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
  });
  const result = await runEmbeddedPiAgent({
    sessionId,
    sessionKey,
    sessionFile: resolveSessionTranscriptPath(sessionId, QUALITY_GUARD_AGENT_ID),
    agentId: QUALITY_GUARD_AGENT_ID,
    workspaceDir,
    agentDir,
    config: params.cfg,
    skillsSnapshot,
    prompt: buildQualityGuardPrompt({
      originalPrompt: params.originalPrompt,
      candidateText: params.candidateText,
      successCriteria: params.successCriteria,
      evidenceSummary: params.evidenceSummary,
      round: params.round,
    }),
    trigger: "manual",
    disableTools: true,
    disableMessageTool: true,
    bootstrapContextMode: "lightweight",
    provider: modelRef.provider,
    model: modelRef.model,
    thinkLevel: "high",
    reasoningLevel: "on",
    timeoutMs: Math.min(Math.max(params.timeoutMs, 30_000), 180_000),
    runId: `${params.runId}:quality-guard:${String(params.round)}`,
  });
  return parseQualityGuardReview(collectVisibleReplyText(result.payloads));
}

async function runChiefRevision(params: {
  cfg: OpenClawConfig;
  originalPrompt: string;
  candidateText: string;
  review: QualityGuardReviewContract;
  timeoutMs: number;
  runId: string;
  round: number;
  workspaceDir: string;
  provider?: string;
  model?: string;
  chiefSkillsSnapshot?: SkillSnapshot;
}): Promise<string> {
  const sessionId = crypto.randomUUID();
  const sessionKey = `agent:${CHIEF_AGENT_ID}:revision-${sessionId}`;
  const chiefWorkspaceDir = resolveAgentWorkspaceDir(params.cfg, CHIEF_AGENT_ID);
  const chiefAgentDir = resolveAgentDir(params.cfg, CHIEF_AGENT_ID);
  const chiefModelRef =
    params.provider && params.model
      ? { provider: params.provider, model: params.model }
      : resolveDefaultModelForAgent({ cfg: params.cfg, agentId: CHIEF_AGENT_ID });
  const chiefSkillsSnapshot =
    params.chiefSkillsSnapshot ??
    buildWorkspaceSkillSnapshot(chiefWorkspaceDir, {
      config: params.cfg,
      skillFilter: resolveAgentSkillsFilter(params.cfg, CHIEF_AGENT_ID),
      eligibility: { remote: getRemoteSkillEligibility() },
      snapshotVersion: getSkillsSnapshotVersion(chiefWorkspaceDir),
    });
  const result = await runEmbeddedPiAgent({
    sessionId,
    sessionKey,
    sessionFile: resolveSessionTranscriptPath(sessionId, CHIEF_AGENT_ID),
    agentId: CHIEF_AGENT_ID,
    workspaceDir: params.workspaceDir || chiefWorkspaceDir,
    agentDir: chiefAgentDir,
    config: params.cfg,
    skillsSnapshot: chiefSkillsSnapshot,
    prompt: buildChiefRevisionPrompt({
      originalPrompt: params.originalPrompt,
      candidateText: params.candidateText,
      review: params.review,
      round: params.round,
    }),
    trigger: "manual",
    disableTools: true,
    disableMessageTool: true,
    bootstrapContextMode: "lightweight",
    provider: chiefModelRef.provider,
    model: chiefModelRef.model,
    timeoutMs: Math.min(Math.max(params.timeoutMs, 30_000), 180_000),
    runId: `${params.runId}:chief-revise:${String(params.round)}`,
  });
  return collectVisibleReplyText(result.payloads);
}

function buildReviewedPayloads(params: {
  text: string;
  originalPayloads?: ReplyPayload[];
}): ReplyPayload[] {
  const mediaUrls = collectVisibleMediaUrls(params.originalPayloads);
  const basePayload = normalizeReplyPayload({
    text: params.text,
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
  });
  return basePayload ? [basePayload] : [];
}

export async function maybeApplyChiefQualityGuard(params: ChiefQualityGuardParams): Promise<{
  result: EmbeddedPiRunResult;
  applied: boolean;
  verdict?: QualityGuardVerdict;
}> {
  const replyText = collectVisibleReplyText(params.result.payloads);
  if (
    !shouldRequireChiefQualityGuardReview({
      agentId: params.agentId,
      originalPrompt: params.originalPrompt,
      replyText,
    })
  ) {
    return {
      result: {
        ...params.result,
        meta: {
          ...params.result.meta,
          qualityGuard: {
            applied: false,
            reviewRounds: 0,
          },
        },
      },
      applied: false,
    };
  }

  let currentText = replyText;
  let lastReview: QualityGuardReviewContract | undefined;
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round += 1) {
    const review = await runQualityGuardReview({
      cfg: params.cfg,
      originalPrompt: params.originalPrompt,
      candidateText: currentText,
      successCriteria: params.successCriteria,
      evidenceSummary: params.evidenceSummary,
      timeoutMs: params.timeoutMs,
      runId: params.runId,
      round,
    });
    lastReview = review;
    if (review.verdict === "approve" && review.can_finalize) {
      if (currentText === replyText) {
        return {
          result: {
            ...params.result,
            meta: {
              ...params.result.meta,
              qualityGuard: {
                applied: true,
                verdict: "approve",
                reviewRounds: round,
              },
            },
          },
          applied: true,
          verdict: "approve",
        };
      }
      return {
        applied: true,
        verdict: "approve",
        result: {
          ...params.result,
          meta: {
            ...params.result.meta,
            qualityGuard: {
              applied: true,
              verdict: "approve",
              reviewRounds: round,
            },
          },
          payloads: buildReviewedPayloads({
            text: currentText,
            originalPayloads: params.result.payloads,
          }),
        },
      };
    }
    if (review.verdict === "block" || round >= MAX_REVIEW_ROUNDS) {
      const blockedText = buildBlockedFinalizationMessage({ review });
      return {
        applied: true,
        verdict: review.verdict,
        result: {
          ...params.result,
          meta: {
            ...params.result.meta,
            qualityGuard: {
              applied: true,
              verdict: review.verdict,
              reviewRounds: round,
            },
          },
          payloads: buildReviewedPayloads({
            text: blockedText,
            originalPayloads: params.result.payloads,
          }),
        },
      };
    }
    currentText = await runChiefRevision({
      cfg: params.cfg,
      originalPrompt: params.originalPrompt,
      candidateText: currentText,
      review,
      timeoutMs: params.timeoutMs,
      runId: params.runId,
      round,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      model: params.model,
      chiefSkillsSnapshot: params.chiefSkillsSnapshot,
    });
  }

  log.warn(
    `Chief quality guard fell through without a terminal verdict. Last review=${JSON.stringify(lastReview)}`,
  );
  return {
    applied: true,
    verdict: "block",
    result: {
      ...params.result,
      meta: {
        ...params.result.meta,
        qualityGuard: {
          applied: true,
          verdict: "block",
          reviewRounds: MAX_REVIEW_ROUNDS,
        },
      },
      payloads: buildReviewedPayloads({
        text: buildBlockedFinalizationMessage(
          {
            review:
              lastReview ?? {
                verdict: "block",
                severity: "high",
                findings: ["The final review gate did not return an approval."],
                missing_evidence: [],
                scope_or_logic_issues: [],
                required_revisions: [],
                paperclip_update_safe: false,
                can_finalize: false,
              },
          },
        ),
        originalPayloads: params.result.payloads,
      }),
    },
  };
}
