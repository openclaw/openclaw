/**
 * Vault Reporter Hook — intercepts long outbound messages, writes full content
 * to the Obsidian vault on Pop!_OS, and replaces the Telegram message with a
 * short summary + link.
 *
 * Uses the `message_sending` hook (modifying, sequential) so it runs before
 * delivery and can replace the content.
 *
 * Fail-open: if the vault write fails, the original message passes through
 * for normal Telegram chunking.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "../../api.js";

const execAsync = promisify(exec);

// --- Config defaults ---

const DEFAULT_THRESHOLD = 1500;
const DEFAULT_VAULT_HOST = "100.119.126.67"; // Pop!_OS
const DEFAULT_VAULT_USER = "jeff";
const DEFAULT_VAULT_ROOT = "/home/jeff/Documents/OpenClaw";
const DEFAULT_OUTPOST_BASE = "https://gateway.juxtagiraffe.appboxes.co/outpost";
const JARVIS_ROOT = "Jarvis";

// --- Domain detection ---

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  fleet: [
    "fleet",
    "node",
    "health",
    "docker",
    "kubuntu",
    "gateway",
    "pop-os",
    "popos",
    "uptime",
    "container",
  ],
  council: ["council", "decision", "vote", "proposal", "consensus", "deliberation"],
  analysis: [
    "analysis",
    "review",
    "audit",
    "report",
    "investigation",
    "findings",
    "recommendation",
  ],
  skills: ["skill", "autoresearch", "improvement", "library", "SKILL.md"],
};

function detectDomain(content: string): string {
  const lower = content.toLowerCase();
  let bestDomain = "general";
  let bestCount = 0;

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const count = keywords.filter((kw) => lower.includes(kw)).length;
    if (count > bestCount) {
      bestCount = count;
      bestDomain = domain;
    }
  }

  return bestDomain;
}

// --- Text utilities ---

function slugify(text: string, maxLen = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function extractTitle(content: string): string {
  // Try markdown heading first
  const headingMatch = content.match(/^#+\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();

  // Fall back to first sentence
  const sentenceMatch = content.match(/^(.+?[.!?])\s/);
  if (sentenceMatch) return sentenceMatch[1].trim().slice(0, 80);

  return content.slice(0, 60).trim();
}

function extractSummary(content: string, title: string, url: string): string {
  const lines = content.split("\n").filter((l) => l.trim());

  // Skip the title line if it matches
  let bodyLines = lines;
  if (bodyLines[0]?.replace(/^#+\s*/, "").trim() === title) {
    bodyLines = bodyLines.slice(1);
  }

  // Take first 1-2 meaningful lines (up to 250 chars)
  let summary = "";
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("```") ||
      trimmed.startsWith("|") ||
      trimmed.startsWith("---")
    )
      continue;
    if (summary.length + trimmed.length > 250) break;
    summary += (summary ? " " : "") + trimmed;
  }

  if (!summary) summary = title;

  return `${title}\n\n${summary}\n\nFull report: ${url}`;
}

// --- Vault write via SSH ---

async function writeToVault(
  content: string,
  vaultHost: string,
  vaultUser: string,
  vaultRoot: string,
  outpostBase: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ summary: string; path: string; url: string } | null> {
  const domain = detectDomain(content);
  const title = extractTitle(content);
  const slug = slugify(title);
  const now = new Date();
  const dateStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const notePath = `${JARVIS_ROOT}/${capitalize(domain)}/${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${dateStr}-${slug}.md`;
  const fullPath = `${vaultRoot}/${notePath}`;

  // Build frontmatter
  const frontmatter = [
    "---",
    `type: jarvis/${domain}`,
    `date: ${now.toISOString()}`,
    `domain: ${domain}`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `tags: [jarvis, auto-report, ${domain}]`,
    "severity: info",
    "source: vault-reporter-hook",
    "---",
  ].join("\n");

  const fullContent = `${frontmatter}\n\n${content}`;

  // Write via SSH using heredoc to handle special chars
  const mkdirCmd = `mkdir -p "$(dirname '${fullPath}')"`;
  const writeCmd = `cat > '${fullPath}'`;

  try {
    await execAsync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ${vaultUser}@${vaultHost} '${mkdirCmd} && ${writeCmd}' << 'VAULT_EOF'\n${fullContent}\nVAULT_EOF`,
      { timeout: 15000 },
    );

    const url = `${outpostBase}/vault/report/${encodeURIComponent(notePath)}`;
    const summary = extractSummary(content, title, url);

    logger.info(
      `vault-reporter: wrote ${notePath} (${content.length} chars → ${summary.length} char summary)`,
    );

    return { summary, path: notePath, url };
  } catch (err) {
    logger.warn(`vault-reporter: SSH write failed, falling back to normal delivery: ${err}`);
    return null;
  }
}

// --- Hook registration ---

export function registerVaultReporter(api: OpenClawPluginApi): void {
  const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
  const vaultConfig = (pluginConfig?.vaultReporter as Record<string, unknown>) || {};

  const enabled = vaultConfig.enabled !== false; // default true
  const threshold = (vaultConfig.threshold as number) || DEFAULT_THRESHOLD;
  const vaultHost =
    (vaultConfig.vaultHost as string) || process.env.VAULT_HOST || DEFAULT_VAULT_HOST;
  const vaultUser =
    (vaultConfig.vaultUser as string) || process.env.VAULT_USER || DEFAULT_VAULT_USER;
  const vaultRoot =
    (vaultConfig.vaultRoot as string) || process.env.VAULT_ROOT || DEFAULT_VAULT_ROOT;
  const outpostBase =
    (vaultConfig.outpostBaseUrl as string) || process.env.OUTPOST_BASE_URL || DEFAULT_OUTPOST_BASE;

  if (!enabled) {
    api.logger.info("vault-reporter: disabled by config");
    return;
  }

  api.on("message_sending", async (event) => {
    const ev = event as Record<string, unknown>;
    const ctx = (ev._ctx || ev.ctx || {}) as Record<string, unknown>;
    const channelId = ctx.channelId as string | undefined;
    const content = ev.content as string | undefined;

    // Only intercept Telegram messages
    if (channelId && channelId !== "telegram") return undefined;

    // Only intercept long messages
    if (!content || content.length < threshold) return undefined;

    // Don't intercept messages that are mostly code (likely a paste, not a report)
    const codeBlockChars = (content.match(/```[\s\S]*?```/g) || []).join("").length;
    if (codeBlockChars > content.length * 0.8) return undefined;

    const result = await writeToVault(
      content,
      vaultHost,
      vaultUser,
      vaultRoot,
      outpostBase,
      api.logger,
    );

    if (result) {
      // Replace message with summary + link
      return { content: result.summary };
    }

    // Fail-open: let the original message through for normal chunking
    return undefined;
  });

  api.logger.info(`vault-reporter: enabled (threshold=${threshold}, host=${vaultHost})`);
}
