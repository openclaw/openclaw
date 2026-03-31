/**
 * bodhi-session-context hook handler
 *
 * Fires on agent:bootstrap.
 * Reads vault state and last session time.
 * Injects SESSION_CONTEXT.md into Bo's bootstrap files.
 * Never crashes bootstrap. Fails silently.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const VAULT_NODES_PATH = path.join(os.homedir(), ".alfred", "vault", "nodes.json");
const SOMATIC_HISTORY_PATH = path.join(os.homedir(), ".openclaw", "somatic-history.jsonl");

// Threshold below which Bo is in intake mode (no patterns to synthesize)
const COLD_START_THRESHOLD = 5;

// Gap (in days) after which Bo acknowledges the return
const RETURN_GAP_DAYS = 7;

interface DomainCounts {
  [domain: string]: number;
}

function readVaultStats(): { nodeCount: number; domains: DomainCounts } {
  try {
    if (!fs.existsSync(VAULT_NODES_PATH)) {
      return { nodeCount: 0, domains: {} };
    }
    const raw = fs.readFileSync(VAULT_NODES_PATH, "utf-8");
    const nodes: Array<{ domain?: string }> = JSON.parse(raw);
    const domains: DomainCounts = {};
    for (const node of nodes) {
      const d = node.domain || "unknown";
      domains[d] = (domains[d] || 0) + 1;
    }
    return { nodeCount: nodes.length, domains };
  } catch {
    return { nodeCount: 0, domains: {} };
  }
}

function readLastSessionTime(): string | null {
  try {
    if (!fs.existsSync(SOMATIC_HISTORY_PATH)) return null;
    const raw = fs.readFileSync(SOMATIC_HISTORY_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    // Last line has the most recent entry
    const last = JSON.parse(lines[lines.length - 1]);
    return last.message_timestamp || null;
  } catch {
    return null;
  }
}

function daysSince(isoTimestamp: string): number {
  try {
    const ts = new Date(isoTimestamp).getTime();
    return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

function buildSessionContextMarkdown(
  nodeCount: number,
  domains: DomainCounts,
  lastSessionTs: string | null
): string {
  const isColdStart = nodeCount < COLD_START_THRESHOLD;
  const daysSinceSession = lastSessionTs ? daysSince(lastSessionTs) : null;
  const isLongReturn = daysSinceSession !== null && daysSinceSession >= RETURN_GAP_DAYS;

  // Sort domains by count descending
  const sortedDomains = Object.entries(domains)
    .sort(([, a], [, b]) => b - a)
    .map(([d, count]) => `${d}: ${count} node${count !== 1 ? "s" : ""}`);

  const lines: string[] = [
    "# SESSION_CONTEXT",
    "",
    "## Vault State",
    `- Total nodes: ${nodeCount}`,
    `- Mode: ${isColdStart ? "INTAKE — vault is sparse, no patterns yet" : "SYNTHESIS — patterns exist"}`,
  ];

  if (sortedDomains.length > 0) {
    lines.push(`- Domains: ${sortedDomains.join(", ")}`);
  } else {
    lines.push("- Domains: none yet");
  }

  lines.push("");
  lines.push("## Session Gap");

  if (lastSessionTs === null) {
    lines.push("- Last session: no history (possibly first session ever)");
    lines.push("- Return gap: unknown");
  } else {
    lines.push(`- Last session: ${lastSessionTs}`);
    lines.push(
      daysSinceSession === 0
        ? "- Return gap: same day — continuity assumed"
        : `- Return gap: ${daysSinceSession} day${daysSinceSession !== 1 ? "s" : ""}`
    );
    if (isLongReturn) {
      lines.push(
        "- LONG RETURN: person has been away over a week. Check in gently before synthesis."
      );
    }
  }

  lines.push("");
  lines.push("## Protocol");

  if (isColdStart) {
    lines.push(
      "1. INTAKE MODE — do not attempt pattern synthesis. The vault is sparse.",
      "2. Receive whatever was sent. Respond to the content, not to a schema.",
      "3. Do not explain the system. Do not list capabilities. Do not greet.",
      "4. Ask one question to deepen what was shared — what brought this to mind?",
      "5. Every message is a vault entry. Receive it as one."
    );
  } else if (isLongReturn) {
    lines.push(
      "1. LONG RETURN — acknowledge the gap briefly before synthesis.",
      "2. Do not assume continuity from previous sessions — context window is fresh.",
      '3. A brief check-in is appropriate: "You\'ve been away. Where are you now?"',
      "4. Then receive what was brought, and proceed with normal synthesis.",
      "5. Do not pressure for an update. One question only."
    );
  } else {
    lines.push(
      "1. SYNTHESIS MODE — vault has patterns. Normal operation.",
      "2. Receive what was sent first. Then reference patterns if relevant.",
      "3. Do not open with pattern data unprompted — wait for readiness signals.",
      "4. If threshold is approaching in any domain, this is a readiness moment."
    );
  }

  return lines.join("\n");
}

const handler = async (event: any): Promise<void> => {
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return;
  }

  try {
    const { nodeCount, domains } = readVaultStats();
    const lastSessionTs = readLastSessionTime();

    const markdown = buildSessionContextMarkdown(nodeCount, domains, lastSessionTs);

    if (event.context?.bootstrapFiles && Array.isArray(event.context.bootstrapFiles)) {
      event.context.bootstrapFiles.push({
        filename: "SESSION_CONTEXT.md",
        content: markdown,
      });
    }
  } catch (err) {
    // Never crash agent bootstrap.
    console.error(
      "[bodhi-session-context] Error:",
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default handler;
