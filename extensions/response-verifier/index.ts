/**
 * Response Verifier Plugin
 *
 * Verifies agent completion claims against the audit log before responses are delivered.
 * Uses the before_response hook to intercept responses and check for verification.
 *
 * When the agent claims to have done something (sent a message, created a file, etc.),
 * this plugin checks the audit log to verify the action actually occurred.
 *
 * Modes:
 * - strictMode: false (default) — Prepend warning if verification fails
 * - strictMode: true — Block unverified responses entirely
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type ResponseVerifierConfig = {
  strictMode?: boolean;
  completionPatterns?: string[];
};

// Patterns that indicate the agent is claiming completion
const DEFAULT_COMPLETION_PATTERNS = [
  // Direct completion claims
  /\b(done|completed|finished|created|sent|wrote|saved|updated|deleted|removed|installed|deployed|pushed|committed)\b/i,
  // Confirmation phrases
  /\b(i('ve| have)|that('s| is)|it('s| is))\s+(done|complete|finished|sent|created|ready)\b/i,
  // Action confirmations
  /\b(successfully|just)\s+(sent|created|wrote|saved|updated|deleted|pushed|committed)\b/i,
];

// Patterns to extract claimed actions from text
const ACTION_EXTRACTION_PATTERNS = [
  // "I sent the message" / "I've sent the message"
  {
    pattern: /\bi('ve| have)?\s*(sent|delivered)\s+(the\s+)?(message|email|notification)/i,
    action: "message",
  },
  // "I created the file" / "I wrote to the file"
  {
    pattern: /\bi('ve| have)?\s*(created|wrote|saved|updated)\s+(the\s+)?(file|document)/i,
    action: "write",
  },
  // "I ran the command" / "I executed the command"
  { pattern: /\bi('ve| have)?\s*(ran|executed|run)\s+(the\s+)?(command|script)/i, action: "exec" },
  // "I pushed the changes" / "I committed the code"
  {
    pattern: /\bi('ve| have)?\s*(pushed|committed)\s+(the\s+)?(changes|code|update)/i,
    action: "exec",
  },
  // "Done" / "Complete" / "Finished"
  { pattern: /^(done|complete|finished)\.?$/i, action: "completion" },
];

function resolveAuditLogPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "logs", "audit.jsonl");
}

interface AuditEntry {
  ts: string;
  type: string;
  tool?: string;
  success?: boolean;
  sessionKey?: string;
  [key: string]: unknown;
}

async function readRecentAuditEntries(
  logPath: string,
  sessionKey?: string,
  maxAge: number = 5 * 60 * 1000, // 5 minutes
): Promise<AuditEntry[]> {
  try {
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const cutoff = new Date(Date.now() - maxAge).toISOString();

    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        // Filter by time and optionally session
        if (entry.ts >= cutoff) {
          if (!sessionKey || entry.sessionKey === sessionKey) {
            entries.push(entry);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    // File doesn't exist or can't be read
    return [];
  }
}

function detectCompletionClaim(text: string, extraPatterns: string[] = []): boolean {
  const patterns = [
    ...DEFAULT_COMPLETION_PATTERNS,
    ...extraPatterns.map((p) => new RegExp(p, "i")),
  ];

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

function extractClaimedActions(text: string): string[] {
  const actions: string[] = [];
  for (const { pattern, action } of ACTION_EXTRACTION_PATTERNS) {
    if (pattern.test(text)) {
      actions.push(action);
    }
  }
  return actions;
}

function verifyActionsInAuditLog(
  claimedActions: string[],
  auditEntries: AuditEntry[],
): { verified: boolean; missing: string[]; found: string[] } {
  const found: string[] = [];
  const missing: string[] = [];

  for (const action of claimedActions) {
    if (action === "completion") {
      // Generic completion claim - check if ANY tool was called
      if (auditEntries.some((e) => e.type === "tool_call" && e.success)) {
        found.push(action);
      } else {
        missing.push(action);
      }
    } else if (action === "message") {
      // Check for message_sent or message tool call
      if (
        auditEntries.some(
          (e) =>
            e.type === "message_sent" ||
            (e.type === "tool_call" && e.tool === "message" && e.success),
        )
      ) {
        found.push(action);
      } else {
        missing.push(action);
      }
    } else {
      // Check for corresponding tool call
      if (auditEntries.some((e) => e.type === "tool_call" && e.tool === action && e.success)) {
        found.push(action);
      } else {
        missing.push(action);
      }
    }
  }

  return {
    verified: missing.length === 0,
    missing,
    found,
  };
}

const plugin = {
  id: "response-verifier",
  name: "Response Verifier",
  description: "Verifies agent completion claims against audit log",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as ResponseVerifierConfig | undefined;
    const strictMode = config?.strictMode ?? false;
    const extraPatterns = config?.completionPatterns ?? [];
    const auditLogPath = resolveAuditLogPath();

    api.logger.info(
      `Response verifier enabled (strictMode: ${strictMode}, auditLog: ${auditLogPath})`,
    );

    api.on(
      "before_response",
      async (event, ctx) => {
        const { text } = event;

        // Check if response contains completion claims
        if (!detectCompletionClaim(text, extraPatterns)) {
          // No completion claim detected, allow response
          return undefined;
        }

        // Extract what actions are being claimed
        const claimedActions = extractClaimedActions(text);
        if (claimedActions.length === 0) {
          // Has completion-like language but no specific actions claimed
          return undefined;
        }

        // Read recent audit entries
        const auditEntries = await readRecentAuditEntries(auditLogPath, ctx.sessionKey);

        // Verify claimed actions against audit log
        const verification = verifyActionsInAuditLog(claimedActions, auditEntries);

        if (verification.verified) {
          // All claimed actions verified in audit log
          api.logger.debug?.(`[response-verifier] Verified: ${verification.found.join(", ")}`);
          return undefined;
        }

        // Verification failed
        const warningMsg =
          `Unverified claims: ${verification.missing.join(", ")}. ` +
          `These actions were not found in the audit log.`;

        api.logger.warn(`[response-verifier] ${warningMsg}`);

        if (strictMode) {
          // Block the response entirely
          return {
            block: true,
            blockReason: warningMsg,
          };
        } else {
          // Prepend a warning but allow the response
          return {
            prependWarning: `VERIFICATION WARNING: ${warningMsg}`,
          };
        }
      },
      { priority: 50 }, // Run after other hooks but before delivery
    );
  },
};

export default plugin;
