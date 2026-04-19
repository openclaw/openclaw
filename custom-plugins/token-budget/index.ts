import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Token Budget Plugin
 *
 * Enforces a monthly token usage limit with:
 * - Warning appended to all outgoing messages at >= 90% usage
 * - Automatic fallback to Azure OpenAI GPT-4o at 100% usage
 * - Checkpoint persistence across container restarts (Azure File Share)
 * - Automatic reset on UTC month rollover
 *
 * Config: openclaw.json → plugins.entries.token-budget.config
 * State:  ~/.openclaw/token-budget.json
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// ── Types ────────────────────────────────────────────────────────

type BudgetCheckpoint = {
  monthKey: string;
  totalTokens: number;
  updatedAt: number;
};

type PluginConfig = {
  monthlyLimit?: number;
  warningThreshold?: number;
  fallbackProvider?: string;
  fallbackModel?: string;
};

// ── Constants ────────────────────────────────────────────────────

const CHECKPOINT_PATH = path.join(os.homedir(), ".openclaw", "token-budget.json");

// ── In-memory state ──────────────────────────────────────────────

let monthKey = "";
let totalTokens = 0;
let monthlyLimit = 2_000_000;
let warningThreshold = 0.9;
let fallbackProvider = "azure-openai";
let fallbackModel = "gpt-4o";

// ── Helpers ──────────────────────────────────────────────────────

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Reset token count if the UTC month has rolled over. */
function ensureCurrentMonth(): void {
  const current = currentMonthKey();
  if (monthKey !== current) {
    monthKey = current;
    totalTokens = 0;
    persistCheckpoint();
  }
}

/** Load persisted token count from the checkpoint file on disk. */
function loadCheckpoint(): void {
  try {
    const raw = fs.readFileSync(CHECKPOINT_PATH, "utf-8");
    const data: BudgetCheckpoint = JSON.parse(raw);
    const current = currentMonthKey();
    if (data.monthKey === current) {
      totalTokens = data.totalTokens || 0;
      monthKey = data.monthKey;
    } else {
      // Stale checkpoint — new month
      monthKey = current;
      totalTokens = 0;
    }
  } catch {
    // No checkpoint or corrupt — start fresh for this month
    monthKey = currentMonthKey();
    totalTokens = 0;
  }
}

/** Persist current token count to disk so it survives container restarts. */
function persistCheckpoint(): void {
  const data: BudgetCheckpoint = {
    monthKey,
    totalTokens,
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal: in-memory state is still accurate
  }
}

function getPercentUsed(): number {
  return monthlyLimit > 0 ? (totalTokens / monthlyLimit) * 100 : 0;
}

function isWarning(): boolean {
  return getPercentUsed() >= warningThreshold * 100;
}

function isExceeded(): boolean {
  return totalTokens >= monthlyLimit;
}

/** Returns the ISO date string for the 1st of the next UTC month. */
function getResetDate(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().split("T")[0];
}

function fmt(n: number): string {
  return n.toLocaleString();
}

// ── Plugin Entry ─────────────────────────────────────────────────

export default definePluginEntry({
  id: "token-budget",
  name: "Token Budget",
  description: "Monthly token usage limit with warning and Azure OpenAI GPT-4o fallback",
  register(api) {
    // Read plugin-specific config from openclaw.json → plugins.entries.token-budget.config
    const cfg = (api.pluginConfig || {}) as PluginConfig;
    monthlyLimit = typeof cfg.monthlyLimit === "number" ? cfg.monthlyLimit : 2_000_000;
    warningThreshold = typeof cfg.warningThreshold === "number" ? cfg.warningThreshold : 0.9;
    fallbackProvider =
      typeof cfg.fallbackProvider === "string" ? cfg.fallbackProvider : "azure-openai";
    fallbackModel = typeof cfg.fallbackModel === "string" ? cfg.fallbackModel : "gpt-4o";

    // ── Hook 1: Initialize on gateway start ──────────────────────
    api.on("gateway_start", () => {
      loadCheckpoint();
      api.logger.info(
        `Token budget: ${fmt(totalTokens)} / ${fmt(monthlyLimit)} ` +
          `(${getPercentUsed().toFixed(1)}%) — month ${monthKey}`,
      );
    });

    // ── Hook 2: Accumulate ALL tokens from every LLM response ────
    api.on("llm_output", (event) => {
      ensureCurrentMonth();
      const u = event.usage;
      if (!u) {
        return;
      }
      // Count all token types: input + output + cache read + cache write
      const tokens = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      totalTokens += tokens;
      persistCheckpoint();
      if (isExceeded()) {
        api.logger.warn(
          `Token limit EXCEEDED: ${fmt(totalTokens)} / ${fmt(monthlyLimit)}. ` +
            `Falling back to ${fallbackProvider}/${fallbackModel}.`,
        );
      }
    });

    // ── Hook 3: Force Azure OpenAI GPT-4o when budget exceeded ───
    api.on("before_model_resolve", () => {
      ensureCurrentMonth();
      if (!isExceeded()) {
        return;
      }
      return {
        providerOverride: fallbackProvider,
        modelOverride: fallbackModel,
      };
    });

    // ── Hook 4: Append warning to ALL outgoing messages ──────────
    api.on("message_sending", (event) => {
      ensureCurrentMonth();
      if (!isWarning()) {
        return;
      }
      const pct = getPercentUsed().toFixed(0);
      const resetDate = getResetDate();
      if (isExceeded()) {
        return {
          content:
            `${event.content}\n\n` +
            `🚫 Monthly token limit reached (${fmt(totalTokens)} / ${fmt(monthlyLimit)}). ` +
            `Responses served via ${fallbackModel} fallback until ${resetDate}.`,
        };
      }
      return {
        content:
          `${event.content}\n\n` +
          `⚠️ Token usage: ${pct}% of monthly limit ` +
          `(${fmt(totalTokens)} / ${fmt(monthlyLimit)}). Resets ${resetDate}.`,
      };
    });

    // NO registerTool — limit not queryable by users
    // NO registerCommand — no /budget slash command
    // NO registerHttpRoute — no API endpoint to change limit
  },
});
