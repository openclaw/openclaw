/**
 * bodhi-safety-validator hook handler
 *
 * Fires on message:sent.
 * Validates outgoing content against dismissal patterns.
 * Logs safety events to ~/.openclaw/safety-log.jsonl (append-only).
 * Never blocks or modifies the message — observes only.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SOMATIC_STATE_PATH = path.join(os.homedir(), ".openclaw", "somatic-state.json");
const SAFETY_LOG_PATH = path.join(os.homedir(), ".openclaw", "safety-log.jsonl");

// Patterns that indicate dismissal of vulnerability
// Matched case-insensitively against the outgoing message
const DISMISSAL_PATTERNS: string[] = [
  "look on the bright side",
  "have you tried",
  "you should",
  "everyone feels that way",
  "everyone goes through",
  "at least",
  "that's just",
  "not a big deal",
  "it could be worse",
  "things will get better",
  "just think positive",
  "silver lining",
  "could be worse",
];

function loadCurrentTier(): string {
  try {
    if (!fs.existsSync(SOMATIC_STATE_PATH)) return "green";
    const raw = fs.readFileSync(SOMATIC_STATE_PATH, "utf-8");
    const state = JSON.parse(raw);
    return state.tier || "green";
  } catch {
    return "green";
  }
}

function appendSafetyLog(entry: Record<string, string>): void {
  try {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(SAFETY_LOG_PATH, line, "utf-8");
  } catch (err) {
    console.error(
      "[bodhi-safety-validator] Log write error:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

function excerpt(content: string, maxLen = 80): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
}

const handler = async (event: any): Promise<void> => {
  if (event.type !== "message" || event.action !== "sent") {
    return;
  }

  // Only validate successful sends
  if (!event.context?.success) {
    return;
  }

  const content: string = event.context?.content || "";
  if (!content) {
    return;
  }

  try {
    const tier = loadCurrentTier();
    const contentLower = content.toLowerCase();
    const at = new Date().toISOString();

    // Check for dismissal patterns
    for (const pattern of DISMISSAL_PATTERNS) {
      if (contentLower.includes(pattern)) {
        // Always log dismissal patterns — regardless of tier
        // But flag more urgently at elevated tiers
        const severity = (tier === "orange" || tier === "red") ? "FLAGGED" : "NOTED";
        appendSafetyLog({
          at,
          tier,
          type: `DISMISSAL_PATTERN_${severity}`,
          pattern,
          excerpt: excerpt(content),
        });
        break; // one log entry per message
      }
    }

    // Log emergency tier responses
    if (tier === "red") {
      appendSafetyLog({
        at,
        tier: "red",
        type: "RED_TIER_RESPONSE_SENT",
        note: "Response sent while somatic state was RED. Review for appropriate protocol.",
        excerpt: excerpt(content),
      });
    }
  } catch (err) {
    // Never crash. Observe silently.
    console.error(
      "[bodhi-safety-validator] Error:",
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default handler;
