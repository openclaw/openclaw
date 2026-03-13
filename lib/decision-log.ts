/**
 * Decision Log
 *
 * Append-only decision registry.
 * Never loses explicit decisions.
 * Provides immutable audit trail of all decisions made.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DECISIONS_DIR = path.join(process.cwd(), "memory", "decisions");
const LOG_FILE = path.join(DECISIONS_DIR, "decisions.jsonl");

// Decision status values
const DECISION_STATUS = {
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  REVOKED: "revoked",
  COMPLETED: "completed",
};

export interface DecisionEntry {
  id: string;
  timestamp: string;
  decision: string;
  context: string;
  rationale: string;
  alternatives: string[];
  status: string;
  checksum: string;
  sessionId: string;
  relatedTo?: string;
}

export interface DecisionData {
  decision: string;
  context?: string;
  rationale?: string;
  alternatives?: string[];
  sessionId?: string;
  relatedTo?: string;
}

/**
 * Ensure directories exist
 */
function ensureDirectories(): void {
  if (!fs.existsSync(DECISIONS_DIR)) {
    fs.mkdirSync(DECISIONS_DIR, { recursive: true });
  }
}

/**
 * Generate unique decision ID
 */
function generateDecisionId(content: string): string {
  const timestamp = Date.now();
  const hash = crypto
    .createHash("sha256")
    .update(content + timestamp)
    .digest("hex");
  return `dec_${timestamp}_${hash.slice(0, 12)}`;
}

/**
 * Calculate checksum for a decision entry
 */
function calculateChecksum(entry: Omit<DecisionEntry, "checksum">): string {
  const data = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    decision: entry.decision,
    context: entry.context,
    rationale: entry.rationale,
  });
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Append a decision to the log
 */
export function appendDecision(decisionData: DecisionData): DecisionEntry {
  ensureDirectories();

  const {
    decision,
    context = "",
    rationale = "",
    alternatives = [],
    sessionId = "unknown",
    relatedTo = null,
  } = decisionData;

  if (!decision || typeof decision !== "string") {
    throw new Error("Decision content is required");
  }

  const entry: Omit<DecisionEntry, "checksum"> = {
    id: generateDecisionId(decision),
    timestamp: new Date().toISOString(),
    decision: decision.trim(),
    context: context.trim(),
    rationale: rationale.trim(),
    alternatives: Array.isArray(alternatives) ? alternatives : [],
    status: DECISION_STATUS.ACTIVE,
    sessionId,
    relatedTo,
  };

  const checksum = calculateChecksum(entry);
  const fullEntry: DecisionEntry = { ...entry, checksum };

  // Append to log
  fs.appendFileSync(LOG_FILE, JSON.stringify(fullEntry) + "\n");

  return fullEntry;
}

/**
 * Log a simple decision (convenience function)
 */
export function logDecision(data: DecisionData): DecisionEntry {
  return appendDecision(data);
}
