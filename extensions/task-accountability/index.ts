/**
 * Task Accountability Plugin
 *
 * Enforces that all substantive work is tied to a GitHub issue.
 *
 * Two-layer approach (ADR-001):
 * 1. `before_agent_start` — Injects mandatory instructions
 * 2. `before_response` — Verifies GitHub issue referenced before completion
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type TaskAccountabilityConfig = {
  strictMode?: boolean;
  issuePatterns?: string[];
  exemptPatterns?: string[];
  minTaskDurationSeconds?: number;
  // Instruction configuration
  instructions?: string | false; // Custom instructions, or false to disable
  instructionsFile?: string; // Path to custom instructions file
};

// Patterns that indicate a GitHub issue reference
const DEFAULT_ISSUE_PATTERNS = [
  // GitHub issue references: GH-123, #123, issue #123
  /\bGH-\d+\b/i,
  /\b#\d{1,6}\b/,
  /\bissue\s*#?\d+\b/i,
  // GitHub URLs
  /github\.com\/[\w-]+\/[\w-]+\/issues\/\d+/i,
  // Linear-style: GET-123, ABC-123
  /\b[A-Z]{2,5}-\d+\b/,
];

// Patterns that indicate this is a simple response not requiring an issue
const DEFAULT_EXEMPT_PATTERNS = [
  // Questions and clarifications
  /^(what|how|why|when|where|who|can you|could you|would you|do you|is there|are there)\b/i,
  // Heartbeat responses
  /^HEARTBEAT_OK$/,
  /^NO_REPLY$/,
  // Simple acknowledgments
  /^(ok|okay|sure|yes|no|got it|understood|thanks|thank you)\.?$/i,
];

// Patterns indicating completion/work done
const COMPLETION_PATTERNS = [
  /\b(done|completed|finished|created|built|implemented|fixed|resolved|shipped|deployed|pushed|committed)\b/i,
  /\b(i('ve| have)|that('s| is)|it('s| is))\s+(done|complete|finished|ready)\b/i,
  /✅|✓|complete/i,
];

const INSTRUCTIONS = `
## Task Accountability Protocol

**MANDATORY:** All substantive work must be tied to a GitHub issue.

Before starting work that involves:
- Creating or modifying files
- Running commands that change state
- Sending messages on behalf of the user
- Any task expected to take more than 30 seconds

You MUST:
1. Reference an existing issue (e.g., "Working on GH-123" or "This addresses #45")
2. OR create a new issue first (e.g., \`gh issue create --title "..." --body "..."\`)

When claiming completion:
- Reference the issue in your response
- The system will verify this before delivering your response

**Exempt:** Simple questions, clarifications, status checks, and heartbeats do not require issues.
`.trim();

function resolveAuditLogPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "logs", "audit.jsonl");
}

interface AuditEntry {
  ts: string;
  type: string;
  tool?: string;
  params?: Record<string, unknown>;
  success?: boolean;
  durationMs?: number;
  [key: string]: unknown;
}

async function readRecentAuditEntries(
  logPath: string,
  maxAge: number = 10 * 60 * 1000, // 10 minutes
): Promise<AuditEntry[]> {
  try {
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const cutoff = new Date(Date.now() - maxAge).toISOString();

    const entries: AuditEntry[] = [];
    // Read from end for efficiency
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as AuditEntry;
        if (entry.ts < cutoff) break; // Stop when we hit old entries
        entries.unshift(entry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function hasIssueReference(text: string, extraPatterns: string[] = []): boolean {
  const patterns = [...DEFAULT_ISSUE_PATTERNS, ...extraPatterns.map((p) => new RegExp(p, "i"))];

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

function isExemptResponse(text: string, extraPatterns: string[] = []): boolean {
  const patterns = [...DEFAULT_EXEMPT_PATTERNS, ...extraPatterns.map((p) => new RegExp(p, "i"))];

  const trimmed = text.trim();
  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function isCompletionClaim(text: string): boolean {
  for (const pattern of COMPLETION_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

function hasSubstantiveWork(entries: AuditEntry[], minDurationMs: number): boolean {
  // Check if there were tool calls that indicate real work
  const workTools = ["exec", "write", "Edit", "message"];
  let totalDuration = 0;

  for (const entry of entries) {
    if (entry.type === "tool_call" && entry.success) {
      if (workTools.includes(entry.tool ?? "")) {
        totalDuration += entry.durationMs ?? 0;
      }
    }
  }

  return totalDuration >= minDurationMs;
}

function checkAuditForIssueCommands(entries: AuditEntry[]): boolean {
  // Check if `gh issue` commands were run
  for (const entry of entries) {
    if (entry.type === "tool_call" && entry.tool === "exec" && entry.success) {
      const command = String(entry.params?.command ?? "");
      if (/\bgh\s+issue\b/i.test(command)) {
        return true;
      }
    }
  }
  return false;
}

function expandPath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

// Well-known path for custom instructions (avoids config schema issues)
const CUSTOM_INSTRUCTIONS_PATH = "~/.openclaw/protocols/github-workflow.md";

async function loadCustomInstructions(config: TaskAccountabilityConfig): Promise<string | null> {
  // Explicitly disabled via config
  if (config.instructions === false) {
    return null;
  }

  // Check well-known custom instructions file first
  try {
    const customPath = expandPath(CUSTOM_INSTRUCTIONS_PATH);
    const content = await fs.readFile(customPath, "utf-8");
    console.log(`[task-accountability] Using custom instructions from ${CUSTOM_INSTRUCTIONS_PATH}`);
    return content.trim();
  } catch {
    // File doesn't exist, continue
  }

  // Inline custom instructions from config
  if (typeof config.instructions === "string") {
    return config.instructions.trim();
  }

  // Default instructions
  return INSTRUCTIONS;
}

const plugin = {
  id: "task-accountability",
  name: "Task Accountability",
  description: "Enforces GitHub issue accountability for all work",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as TaskAccountabilityConfig | undefined;
    const strictMode = config?.strictMode ?? false;
    const extraIssuePatterns = config?.issuePatterns ?? [];
    const extraExemptPatterns = config?.exemptPatterns ?? [];
    const minTaskDurationMs = (config?.minTaskDurationSeconds ?? 30) * 1000;
    const auditLogPath = resolveAuditLogPath();

    api.logger.info(`Task accountability enabled (strictMode: ${strictMode})`);

    // Cache instructions
    let cachedInstructions: string | null = null;
    let instructionsLoaded = false;

    // Layer 1: Inject instructions at agent start
    api.on("before_agent_start", async () => {
      if (!instructionsLoaded) {
        cachedInstructions = await loadCustomInstructions(config ?? {});
        instructionsLoaded = true;
      }

      if (!cachedInstructions) {
        return undefined; // Instructions disabled
      }

      return {
        prependContext: cachedInstructions,
      };
    });

    // Layer 2: Verify issue reference before completion
    api.on(
      "before_response",
      async (event) => {
        const { text } = event;

        // Skip exempt responses (questions, heartbeats, etc.)
        if (isExemptResponse(text, extraExemptPatterns)) {
          return undefined;
        }

        // Skip if not claiming completion
        if (!isCompletionClaim(text)) {
          return undefined;
        }

        // Check if response already has issue reference
        if (hasIssueReference(text, extraIssuePatterns)) {
          api.logger.debug?.("[task-accountability] Issue reference found in response");
          return undefined;
        }

        // Read audit log to check for substantive work
        const auditEntries = await readRecentAuditEntries(auditLogPath);

        // If no substantive work was done, don't require issue
        if (!hasSubstantiveWork(auditEntries, minTaskDurationMs)) {
          return undefined;
        }

        // Check if gh issue commands were run (indicates issue was created/updated)
        if (checkAuditForIssueCommands(auditEntries)) {
          api.logger.debug?.("[task-accountability] GitHub issue command found in audit log");
          return undefined;
        }

        // Verification failed — work was done but no issue referenced
        const warningMsg =
          "Completion claimed without GitHub issue reference. " +
          "Please reference an issue (e.g., GH-123, #45) or create one with `gh issue create`.";

        api.logger.warn(`[task-accountability] ${warningMsg}`);

        if (strictMode) {
          return {
            block: true,
            blockReason: warningMsg,
          };
        } else {
          return {
            prependWarning: `ACCOUNTABILITY WARNING: ${warningMsg}`,
          };
        }
      },
      { priority: 40 }, // Run after audit-logger but before response-verifier
    );
  },
};

export default plugin;
