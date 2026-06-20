export const JUDGE_VERDICTS = Object.freeze([
  "APPROVE",
  "REJECT",
  "ESCALATE_TO_HUMAN",
  "REQUEST_MORE_EVIDENCE",
  "SANDBOX_ONLY",
]);

export const JUDGE_RISKS = Object.freeze(["low", "medium", "high", "prohibited", "unclear"]);

export const JUDGE_PACKET_FIELDS = Object.freeze([
  "claim_or_action",
  "scope",
  "evidence",
  "instructions",
  "risk",
  "requested_verdict",
]);

export const JUDGE_MANDATORY_GATES = Object.freeze({
  strategic_summon: {
    label: "Strategic Summon Gate",
    requiredEvidence: ["request", "scope", "handoff reason"],
  },
  completion_declaration: {
    label: "Completion Declaration Gate",
    requiredEvidence: ["changed files or affected surface", "verification output", "remaining gap"],
  },
  governance_instruction_mutation: {
    label: "Governance / Instruction Mutation Gate",
    requiredEvidence: ["exact instruction diff", "authority", "rollback path"],
  },
  approval_boundary_risk_tier: {
    label: "Approval-Boundary / Risk-Tier Gate",
    requiredEvidence: ["risk class", "approval status", "affected authority boundary"],
  },
  architecture_change_acceptance: {
    label: "Architecture-Change Acceptance Gate",
    requiredEvidence: ["design scope", "tests", "compatibility impact"],
  },
  strategic_recommendation_acceptance: {
    label: "Strategic Recommendation Acceptance Gate",
    requiredEvidence: ["recommendation", "evidence", "human acceptance status"],
  },
  self_improvement_self_modification: {
    label: "Self-Improvement / Self-Modification Gate",
    requiredEvidence: ["target behavior", "safety impact", "human approval or sandbox boundary"],
  },
});

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
];

const PROHIBITED_TERMS = ["bypass approval", "ignore human", "exfiltrate", "steal token"];

function textOf(value) {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value).map(textOf).join(" ");
  }
  return String(value);
}

function normalizeRisk(value) {
  const risk = String(value ?? "").toLowerCase();
  return JUDGE_RISKS.includes(risk) ? risk : "unclear";
}

export function findMissingJudgePacketFields(packet) {
  return JUDGE_PACKET_FIELDS.filter((field) => {
    const value = packet?.[field];
    return value == null || String(value).trim() === "";
  });
}

export function classifyJudgeRisk(packet) {
  const explicit = normalizeRisk(packet?.risk);
  if (explicit === "prohibited" || explicit === "high") {
    return explicit;
  }

  const haystack = [
    textOf(packet?.claim_or_action),
    textOf(packet?.scope),
    textOf(packet?.instructions),
  ]
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

export function detectEvidenceTier(evidence) {
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

export function detectJudgeContradiction(packet) {
  const claim = textOf(packet?.claim_or_action).toLowerCase();
  const evidence = textOf(packet?.evidence).toLowerCase();
  const successClaim = /(complete|finished|fixed|passed|safe|working|deployed)/.test(claim);
  const failedEvidence = /(failed|exited [1-9]\d*|error|blocked|denied|timeout|timed out)/.test(
    evidence,
  );
  return successClaim && failedEvidence;
}

export function needsFreshEvidence(packet) {
  const claim = textOf(packet?.claim_or_action).toLowerCase();
  return /\b(latest|current|today|live|now|fresh)\b/.test(claim);
}

export function hasFreshEvidence(packet) {
  const evidence = textOf(packet?.evidence).toLowerCase();
  return /(fresh external|web_fetch|web_search|live source|same turn|today|timestamp|fetched)/.test(
    evidence,
  );
}

export function shouldSummonJudge(event) {
  const gate = String(event?.gate ?? "").trim();
  if (gate && Object.hasOwn(JUDGE_MANDATORY_GATES, gate)) {
    return true;
  }
  const text = [textOf(event?.claim_or_action), textOf(event?.scope), textOf(event?.instructions)]
    .join(" ")
    .toLowerCase();
  return [
    "completion declaration",
    "governance",
    "approval-boundary",
    "risk-tier",
    "architecture-change",
    "strategic recommendation",
    "self-modification",
    "production deployment",
  ].some((term) => text.includes(term));
}

export function evaluateJudgePacket(packet) {
  const missing = findMissingJudgePacketFields(packet);
  const risk = classifyJudgeRisk(packet);
  const evidenceTier = detectEvidenceTier(packet?.evidence);
  const directEnough = evidenceTier <= 4;
  const approvalText = textOf(packet?.instructions).toLowerCase();
  const hasHumanApproval = /(human approval present|human approved|approved by human)/.test(
    approvalText,
  );

  if (missing.length > 0) {
    return buildJudgeVerdict({
      verdict: "REQUEST_MORE_EVIDENCE",
      scope: textOf(packet?.scope) || "unknown",
      evidence: "insufficient",
      risk,
      reason: `Missing required packet field(s): ${missing.join(", ")}.`,
      conditions: `provide ${missing.join(", ")}`,
      evidenceTier,
      gate: packet?.gate,
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

function summarizeEvidence(evidence) {
  const text = textOf(evidence).trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text || "insufficient";
}

export function buildJudgeVerdict(params) {
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

export function formatJudgeVerdict(verdict) {
  return [
    `VERDICT: ${verdict.verdict}`,
    `SCOPE: ${verdict.scope}`,
    `EVIDENCE: ${verdict.evidence}`,
    `RISK: ${verdict.risk}`,
    `REASON: ${verdict.reason}`,
    `CONDITIONS: ${verdict.conditions}`,
  ].join("\n");
}

export function parseJudgeVerdict(text) {
  const lines = String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fields = ["VERDICT", "SCOPE", "EVIDENCE", "RISK", "REASON", "CONDITIONS"];
  const errors = [];
  const parsed = {};

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
    parsed[field.toLowerCase()] = line.slice(prefix.length).trim();
  }

  if (parsed.verdict && !JUDGE_VERDICTS.includes(parsed.verdict)) {
    errors.push(`invalid verdict "${parsed.verdict}"`);
  }
  if (parsed.risk && !JUDGE_RISKS.includes(parsed.risk)) {
    errors.push(`invalid risk "${parsed.risk}"`);
  }
  for (const parsedField of fields.map((field) => field.toLowerCase())) {
    if (parsed[parsedField] === "") {
      errors.push(`${parsedField} must not be empty`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    value:
      errors.length === 0
        ? {
            verdict: parsed.verdict,
            scope: parsed.scope,
            evidence: parsed.evidence,
            risk: parsed.risk,
            reason: parsed.reason,
            conditions: parsed.conditions,
          }
        : undefined,
  };
}

export function createJudgeAuditRecord(packet, verdict, meta = {}) {
  return {
    timestamp: meta.timestamp ?? new Date().toISOString(),
    gate: packet?.gate ?? verdict.gate ?? "unspecified",
    verdict: verdict.verdict,
    risk: verdict.risk,
    evidenceTier: verdict.evidenceTier ?? detectEvidenceTier(packet?.evidence),
    scope: verdict.scope,
    conditions: verdict.conditions,
    model: meta.model ?? "unknown",
    runId: meta.runId ?? null,
    packetHash: meta.packetHash ?? stablePacketHash(packet),
  };
}

function stablePacketHash(packet) {
  const json = JSON.stringify(packet ?? {}, Object.keys(packet ?? {}).toSorted());
  let hash = 0;
  for (let index = 0; index < json.length; index += 1) {
    hash = (hash * 31 + json.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
