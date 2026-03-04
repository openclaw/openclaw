import { describe, expect, it, vi } from "vitest";
import {
  formatFundStatus,
  formatRiskStatus,
  formatLeaderboard,
  formatAllocations,
  formatPromoteCheck,
} from "../../src/fund/formatters.js";
import type { FundRiskStatus, LeaderboardEntry, Allocation } from "../../src/fund/types.js";

vi.mock("ccxt", () => ({}));

describe("formatters", () => {
  describe("formatFundStatus", () => {
    it("formats fund status with positive P&L", () => {
      const result = formatFundStatus({
        totalEquity: 125430.5,
        todayPnl: 2890.3,
        todayPnlPct: 2.3,
        riskLevel: "normal",
        dailyDrawdown: 0.8,
        byLevel: { L3_LIVE: 2, L2_PAPER: 3, L1_BACKTEST: 1, L0_INCUBATE: 0, KILLED: 0 },
        allocationCount: 5,
        lastRebalanceAt: "2026-02-25T07:00:00Z",
      });

      expect(result).toContain("FinClaw Fund Status");
      expect(result).toContain("125,430.5");
      expect(result).toContain("+2,890.3");
      expect(result).toContain("+2.3%");
      expect(result).toContain("🟢");
      expect(result).toContain("L3 Live:    2");
      expect(result).toContain("L2 Paper:   3");
    });

    it("formats fund status with negative P&L", () => {
      const result = formatFundStatus({
        totalEquity: 98000,
        todayPnl: -2000,
        todayPnlPct: -2.0,
        riskLevel: "caution",
        dailyDrawdown: 2.0,
        byLevel: { L3_LIVE: 1, L2_PAPER: 2, L1_BACKTEST: 0, L0_INCUBATE: 0, KILLED: 1 },
        allocationCount: 3,
        lastRebalanceAt: "never",
      });

      expect(result).toContain("-2,000");
      expect(result).toContain("-2%");
      expect(result).toContain("🟡");
      expect(result).toContain("Killed:     1");
    });
  });

  describe("formatRiskStatus", () => {
    it("formats normal risk", () => {
      const risk: FundRiskStatus = {
        totalEquity: 125000,
        todayPnl: 1000,
        todayPnlPct: 0.8,
        dailyDrawdown: 0,
        maxAllowedDrawdown: 10,
        riskLevel: "normal",
        activeStrategies: 5,
        exposurePct: 65,
        cashReservePct: 35,
      };

      const result = formatRiskStatus(risk, 1.0, ["Normal operations"]);
      expect(result).toContain("Fund Risk Status");
      expect(result).toContain("NORMAL");
      expect(result).toContain("100%");
      expect(result).toContain("Normal operations");
    });

    it("formats critical risk", () => {
      const risk: FundRiskStatus = {
        totalEquity: 85000,
        todayPnl: -15000,
        todayPnlPct: -15,
        dailyDrawdown: 15,
        maxAllowedDrawdown: 10,
        riskLevel: "critical",
        activeStrategies: 3,
        exposurePct: 80,
        cashReservePct: 20,
      };

      const result = formatRiskStatus(risk, 0, ["HALT all trading", "Notify user"]);
      expect(result).toContain("🔴");
      expect(result).toContain("CRITICAL");
      expect(result).toContain("0%");
      expect(result).toContain("HALT all trading");
    });
  });

  describe("formatLeaderboard", () => {
    it("formats empty leaderboard", () => {
      const result = formatLeaderboard([]);
      expect(result).toContain("No eligible strategies");
    });

    it("formats leaderboard with entries", () => {
      const entries: LeaderboardEntry[] = [
        {
          rank: 1,
          strategyId: "s1",
          strategyName: "MomentumBTC",
          level: "L3_LIVE",
          fitness: 0.85,
          confidenceMultiplier: 1.0,
          leaderboardScore: 0.85,
          sharpe: 1.5,
          maxDrawdown: -12,
          totalTrades: 120,
        },
        {
          rank: 2,
          strategyId: "s2",
          strategyName: "MeanRevertETH",
          level: "L2_PAPER",
          fitness: 0.72,
          confidenceMultiplier: 0.7,
          leaderboardScore: 0.504,
          sharpe: 0.9,
          maxDrawdown: -8,
          totalTrades: 80,
        },
      ];

      const result = formatLeaderboard(entries);
      expect(result).toContain("Strategy Leaderboard");
      expect(result).toContain("MomentumBTC");
      expect(result).toContain("MeanRevertETH");
      expect(result).toContain("```");
    });
  });

  describe("formatAllocations", () => {
    it("formats empty allocations", () => {
      const result = formatAllocations([], 100000);
      expect(result).toContain("No allocations yet");
    });

    it("formats allocations with cash reserve", () => {
      const allocations: Allocation[] = [
        { strategyId: "momentum-btc", capitalUsd: 30000, weightPct: 30, reason: "high-fitness" },
        { strategyId: "mean-revert", capitalUsd: 20000, weightPct: 20, reason: "diversification" },
      ];

      const result = formatAllocations(allocations, 100000);
      expect(result).toContain("Capital Allocations");
      expect(result).toContain("$100,000");
      expect(result).toContain("$50,000");
      expect(result).toContain("Cash Reserve");
    });
  });

  describe("formatPromoteCheck", () => {
    it("formats eligible promotion", () => {
      const result = formatPromoteCheck({
        strategyId: "s-1",
        currentLevel: "L2_PAPER",
        eligible: true,
        targetLevel: "L3_LIVE",
        reasons: ["30+ days in paper", "Sharpe > 1.0", "Max DD < 15%"],
        blockers: [],
      });

      expect(result).toContain("✅");
      expect(result).toContain("L3_LIVE");
      expect(result).toContain("30+ days in paper");
    });

    it("formats ineligible promotion", () => {
      const result = formatPromoteCheck({
        strategyId: "s-2",
        currentLevel: "L1_BACKTEST",
        eligible: false,
        reasons: ["Walk-forward passed"],
        blockers: ["Needs 14+ days in paper", "Needs 20+ trades"],
      });

      expect(result).toContain("❌");
      expect(result).toContain("Blockers:");
      expect(result).toContain("Needs 14+ days in paper");
      expect(result).toContain("Walk-forward passed");
    });
  });
});
