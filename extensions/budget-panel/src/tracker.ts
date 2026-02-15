/**
 * Budget Tracker - Tracks usage across multiple AI providers
 * Wired to real data sources
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ProviderStatus = {
  name: string;
  pct: number;
  used: string;
  remaining: string;
  unit: string;
  budget: number;
};

type ManusUsageFile = {
  credits_used: number;
  credits_budget: number;
  month: string;
  tasks: Array<{ id: string; credits: number; date: string }>;
};

export class BudgetTracker {
  private claudeBudget = 200; // Max plan
  private manusBudget = 500;
  private geminiBudget = 20;

  private claudeUsed = 0;
  private manusUsed = 0;
  private geminiUsed = 0;

  private workspaceDir: string;
  private gatewayClient: any = null;

  constructor(workspaceDir?: string) {
    this.workspaceDir =
      workspaceDir ||
      process.env.OPENCLAW_WORKSPACE ||
      path.join(process.env.HOME || "", ".openclaw", "workspace");
  }

  setProviderBudget(id: string, budget: number): void {
    if (id === "claude") this.claudeBudget = budget;
    if (id === "manus") this.manusBudget = budget;
    if (id === "gemini") this.geminiBudget = budget;
  }

  updateUsage(id: string, used: number): void {
    if (id === "claude") this.claudeUsed = used;
    if (id === "manus") this.manusUsed = used;
    if (id === "gemini") this.geminiUsed = used;
  }

  setGatewayClient(client: any): void {
    this.gatewayClient = client;
  }

  private loadManusUsage(): { used: number; budget: number } {
    // Try multiple paths
    const paths = [
      path.join(this.workspaceDir, "memory", "manus-usage.json"),
      path.join(process.env.HOME || "", ".openclaw", "workspace", "memory", "manus-usage.json"),
    ];

    for (const filePath of paths) {
      try {
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ManusUsageFile;
          // console.log(`[budget-panel] Loaded Manus usage from ${filePath}: ${data.credits_used} credits`);
          return {
            used: data.credits_used || 0,
            budget: data.credits_budget || this.manusBudget,
          };
        }
      } catch (e) {
        console.error(`[budget-panel] Error reading ${filePath}:`, e);
      }
    }
    // console.log(`[budget-panel] No Manus usage file found, using defaults`);
    return { used: this.manusUsed, budget: this.manusBudget };
  }

  private loadClaudeUsage(): {
    used: number;
    budget: number;
    isSubscription: boolean;
    tier?: string;
  } {
    const paths = [
      path.join(process.env.HOME || "", ".openclaw", "workspace", "memory", "claude-usage.json"),
      path.join(this.workspaceDir, "memory", "claude-usage.json"),
    ];

    for (const filePath of paths) {
      try {
        // console.log(`[budget-panel] Checking Claude file: ${filePath}`);
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, "utf-8");
          const data = JSON.parse(raw);
          // console.log(`[budget-panel] Loaded Claude: mode=${data.mode}, tier=${data.tier}`);
          // Check if it's a subscription (no billing)
          if (data.mode === "subscription") {
            return {
              used: data.monthly_fee || 100,
              budget: data.monthly_fee || 100,
              isSubscription: true,
              tier: data.tier,
            };
          }
          return {
            used: data.cost_used || 0,
            budget: data.cost_budget || this.claudeBudget,
            isSubscription: false,
          };
        }
      } catch (e) {
        console.error(`[budget-panel] Claude file error: ${filePath}`, e);
      }
    }
    // console.log(`[budget-panel] No Claude file found, using defaults`);
    return { used: this.claudeUsed, budget: this.claudeBudget, isSubscription: false };
  }

  getStatus(): { providers: ProviderStatus[]; totalPct: number } {
    // Load from files
    const manus = this.loadManusUsage();
    const claude = this.loadClaudeUsage();

    // Claude - handle subscription vs API
    let claudeProvider: ProviderStatus;
    if (claude.isSubscription) {
      claudeProvider = {
        name: `Claude (${claude.tier || "Max"})`,
        pct: 0, // Subscription = no percentage tracking
        used: "Flat",
        remaining: `$${claude.budget}/mo`,
        unit: "",
        budget: claude.budget,
      };
    } else {
      const claudePct = claude.budget > 0 ? (claude.used / claude.budget) * 100 : 0;
      const claudeRemaining = Math.max(0, claude.budget - claude.used);
      claudeProvider = {
        name: "Claude",
        pct: claudePct,
        used: `$${claude.used.toFixed(2)}`,
        remaining: `$${claudeRemaining.toFixed(2)}`,
        unit: "$",
        budget: claude.budget,
      };
    }

    // For backwards compatibility
    const claudeUsed = claude.used;
    const claudeBudget = claude.budget;
    const claudePct = claude.isSubscription
      ? 0
      : claudeBudget > 0
        ? (claudeUsed / claudeBudget) * 100
        : 0;
    const claudeRemaining = Math.max(0, claudeBudget - claudeUsed);

    // Manus
    const manusPct = manus.budget > 0 ? (manus.used / manus.budget) * 100 : 0;
    const manusRemaining = Math.max(0, manus.budget - manus.used);

    // Gemini
    const geminiUsed = this.geminiUsed;
    const geminiBudget = this.geminiBudget;
    const geminiPct = geminiBudget > 0 ? (geminiUsed / geminiBudget) * 100 : 0;
    const geminiRemaining = Math.max(0, geminiBudget - geminiUsed);

    const providers: ProviderStatus[] = [
      claudeProvider,
      {
        name: "Manus",
        pct: manusPct,
        used: String(Math.round(manus.used)),
        remaining: String(Math.round(manusRemaining)),
        unit: "credits",
        budget: manus.budget,
      },
      {
        name: "Gemini",
        pct: geminiPct,
        used: `$${geminiUsed.toFixed(2)}`,
        remaining: `$${geminiRemaining.toFixed(2)}`,
        unit: "$",
        budget: geminiBudget,
      },
    ];

    // Total (normalize to dollars, 1 credit ≈ $0.01)
    const totalUsed = claudeUsed + manus.used * 0.01 + geminiUsed;
    const totalBudget = claudeBudget + manus.budget * 0.01 + geminiBudget;
    const totalPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0;

    return { providers, totalPct };
  }
}
