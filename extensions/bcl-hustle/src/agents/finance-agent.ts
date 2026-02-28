/**
 * Finance Agent
 *
 * Handles multi-wallet support (BTC, ETH, Solana), volatility monitoring,
 * milestone tracking, purchase management, and ROI calculations.
 */

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import {
  getWallets,
  saveWallet,
  getMilestones,
  saveMilestone,
  getFinanceEntries,
  saveFinanceEntry,
  getProjects,
} from "../db/database.js";
import {
  BCL_CORE_VALUES,
  MILESTONE_THRESHOLDS,
  type Wallet,
  type FinanceEntry,
  type Milestone,
  type Project,
} from "../types/index.js";

export type ChainType = "BTC" | "ETH" | "SOL";
export type Currency = "USD" | "BTC" | "ETH" | "SOL";

export interface VolatilityAlert {
  walletId: string;
  chain: ChainType;
  changePercent: number;
  period: string;
  currentBalance: number;
  previousBalance: number;
  timestamp: Date;
}

export interface PurchaseRecord {
  id: string;
  description: string;
  amount: number;
  currency: Currency;
  projectId?: string;
  receiptPath?: string;
  timestamp: Date;
  vendor?: string;
  category?: string;
}

export interface ROIResult {
  projectId: string;
  projectName: string;
  totalRevenue: number;
  totalCosts: number;
  netProfit: number;
  roiPercent: number;
  roiMultiple: number;
}

export interface BalanceSnapshot {
  chain: ChainType;
  balance: number;
  balanceUsd: number;
  timestamp: Date;
}

export interface MilestoneStatus {
  milestone: Milestone;
  progress: number;
  next: number | null;
}

export class FinanceAgent {
  private api: OpenClawPluginApi;
  private volatilityHistory: Map<string, BalanceSnapshot[]> = new Map();
  private readonly VOLATILITY_THRESHOLD = -50;
  private readonly VOLATILITY_PERIOD_DAYS = 90;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  async execute(): Promise<void> {
    this.api.logger.info("Finance Agent: Starting financial operations...");

    try {
      await this.updateWallets();
      await this.checkMilestones();
      await this.calculateROI();

      if (BCL_CORE_VALUES.volatility_monitoring) {
        await this.alertVolatility();
      }

      this.api.logger.info("Finance Agent: Completed");
    } catch (error) {
      this.api.logger.error("Finance Agent failed: " + String(error));
      throw error;
    }
  }

  async getBalance(chain: ChainType): Promise<{ balance: number; balanceUsd: number }> {
    const wallets = getWallets().filter((w: Wallet) => w.chain === chain);

    if (wallets.length === 0) {
      this.api.logger.warn(`Finance: No wallet found for ${chain}`);
      return { balance: 0, balanceUsd: 0 };
    }

    const wallet = wallets[0];
    const balanceUsd = await this.convertToUsd(wallet.balance, chain);

    return { balance: wallet.balance, balanceUsd };
  }

  async getAllBalances(): Promise<BalanceSnapshot[]> {
    const chains: ChainType[] = ["BTC", "ETH", "SOL"];
    const snapshots: BalanceSnapshot[] = [];

    for (const chain of chains) {
      const { balance, balanceUsd } = await this.getBalance(chain);
      snapshots.push({
        chain,
        balance,
        balanceUsd,
        timestamp: new Date(),
      });
    }

    return snapshots;
  }

  async getTransactions(projectId?: string): Promise<FinanceEntry[]> {
    return getFinanceEntries(projectId);
  }

  async trackPurchase(
    description: string,
    amount: number,
    currency: Currency,
    options?: {
      projectId?: string;
      receiptPath?: string;
      vendor?: string;
      category?: string;
    },
  ): Promise<FinanceEntry> {
    const entry: FinanceEntry = {
      id: `purchase_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: "expense",
      amount,
      currency,
      description,
      project_id: options?.projectId,
      receipt_path: options?.receiptPath,
      timestamp: new Date(),
    };

    if (!BCL_CORE_VALUES.require_receipts || entry.receipt_path) {
      saveFinanceEntry(entry);
      this.api.logger.info(`Finance: Tracked purchase - ${description}: ${amount} ${currency}`);
    } else {
      this.api.logger.warn(`Finance: Purchase without receipt - ${description}`);
    }

    return entry;
  }

  async trackIncome(
    description: string,
    amount: number,
    currency: Currency,
    projectId?: string,
  ): Promise<FinanceEntry> {
    const entry: FinanceEntry = {
      id: `income_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: "income",
      amount,
      currency,
      description,
      project_id: projectId,
      timestamp: new Date(),
    };

    saveFinanceEntry(entry);
    this.api.logger.info(`Finance: Tracked income - ${description}: ${amount} ${currency}`);

    return entry;
  }

  async calculateROI(projectId?: string): Promise<ROIResult[]> {
    const projects = projectId
      ? getProjects().filter((p: Project) => p.id === projectId)
      : getProjects();

    const results: ROIResult[] = [];

    for (const project of projects) {
      const entries = getFinanceEntries(project.id);
      const revenue = entries
        .filter((e: FinanceEntry) => e.type === "income")
        .reduce((sum, e: FinanceEntry) => sum + e.amount, 0);
      const costs = entries
        .filter((e: FinanceEntry) => e.type === "expense")
        .reduce((sum, e: FinanceEntry) => sum + e.amount, 0);

      const netProfit = revenue - costs;
      const roiPercent = costs > 0 ? (netProfit / costs) * 100 : 0;
      const roiMultiple = costs > 0 ? revenue / costs : 0;

      const result: ROIResult = {
        projectId: project.id,
        projectName: project.name,
        totalRevenue: revenue,
        totalCosts: costs,
        netProfit,
        roiPercent,
        roiMultiple,
      };

      results.push(result);
      this.api.logger.info(
        `Finance: ROI for ${project.name}: ${roiPercent.toFixed(2)}% (${roiMultiple.toFixed(2)}x)`,
      );
    }

    return results;
  }

  async checkMilestones(): Promise<MilestoneStatus[]> {
    const totalRevenue = this.calculateTotalRevenue();
    const milestones = getMilestones();
    const statuses: MilestoneStatus[] = [];

    for (const threshold of MILESTONE_THRESHOLDS) {
      let milestone = milestones.find((m: Milestone) => m.target_value === threshold);

      if (!milestone) {
        milestone = {
          id: `milestone_${threshold}`,
          type: "revenue",
          target_value: threshold,
          current_value: totalRevenue,
          reached_at: totalRevenue >= threshold ? new Date() : undefined,
          notified: totalRevenue >= threshold,
        };
      } else {
        milestone.current_value = totalRevenue;

        if (totalRevenue >= threshold && !milestone.reached_at) {
          milestone.reached_at = new Date();
          milestone.notified = true;
          this.api.logger.info(`Finance: 🎉 Milestone reached: $${threshold}!`);
        }
      }

      saveMilestone(milestone);

      const sortedThresholds = [...MILESTONE_THRESHOLDS].sort((a, b) => a - b);
      const currentIndex = sortedThresholds.indexOf(threshold);
      const next =
        currentIndex < sortedThresholds.length - 1 ? sortedThresholds[currentIndex + 1] : null;

      statuses.push({
        milestone,
        progress: (totalRevenue / threshold) * 100,
        next,
      });
    }

    return statuses;
  }

  async alertVolatility(): Promise<VolatilityAlert[]> {
    const alerts: VolatilityAlert[] = [];
    const chains: ChainType[] = ["BTC", "ETH", "SOL"];

    for (const chain of chains) {
      const wallets = getWallets().filter((w: Wallet) => w.chain === chain);

      if (wallets.length === 0) continue;

      const wallet = wallets[0];
      const historyKey = wallet.id;

      const currentSnapshot: BalanceSnapshot = {
        chain,
        balance: wallet.balance,
        balanceUsd: await this.convertToUsd(wallet.balance, chain),
        timestamp: new Date(),
      };

      if (!this.volatilityHistory.has(historyKey)) {
        this.volatilityHistory.set(historyKey, []);
      }

      const history = this.volatilityHistory.get(historyKey)!;
      history.push(currentSnapshot);

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.VOLATILITY_PERIOD_DAYS);
      const relevantHistory = history.filter((s: BalanceSnapshot) => s.timestamp >= cutoffDate);

      if (relevantHistory.length >= 2) {
        const oldest = relevantHistory[0];
        const latest = relevantHistory[relevantHistory.length - 1];

        if (oldest.balanceUsd > 0) {
          const changePercent = ((latest.balanceUsd - oldest.balanceUsd) / oldest.balanceUsd) * 100;

          if (changePercent <= this.VOLATILITY_THRESHOLD) {
            const alert: VolatilityAlert = {
              walletId: wallet.id,
              chain,
              changePercent,
              period: `${this.VOLATILITY_PERIOD_DAYS} days`,
              currentBalance: latest.balanceUsd,
              previousBalance: oldest.balanceUsd,
              timestamp: new Date(),
            };

            alerts.push(alert);
            this.api.logger.error(
              `Finance: 🚨 VOLATILITY ALERT - ${chain} dropped ${changePercent.toFixed(2)}% in ${this.VOLATILITY_PERIOD_DAYS} days`,
            );
          }
        }
      }

      if (history.length > 100) {
        this.volatilityHistory.set(historyKey, history.slice(-100));
      }
    }

    return alerts;
  }

  async addWallet(chain: ChainType, address: string, initialBalance: number = 0): Promise<Wallet> {
    const existingWallets = getWallets();
    const existing = existingWallets.find(
      (w: Wallet) => w.chain === chain && w.address.toLowerCase() === address.toLowerCase(),
    );

    if (existing) {
      this.api.logger.warn(`Finance: Wallet already exists for ${chain}`);
      return existing;
    }

    const wallet: Wallet = {
      id: `wallet_${chain.toLowerCase()}_${Date.now()}`,
      chain,
      address,
      balance: initialBalance,
      last_updated: new Date(),
    };

    saveWallet(wallet);
    this.api.logger.info(`Finance: Added new ${chain} wallet: ${address}`);

    return wallet;
  }

  async updateWalletBalance(walletId: string, newBalance: number): Promise<Wallet | null> {
    const wallets = getWallets();
    const wallet = wallets.find((w: Wallet) => w.id === walletId);

    if (!wallet) {
      this.api.logger.warn(`Finance: Wallet not found: ${walletId}`);
      return null;
    }

    wallet.balance = newBalance;
    wallet.last_updated = new Date();
    saveWallet(wallet);

    this.api.logger.info(`Finance: Updated ${wallet.chain} balance: ${newBalance}`);

    return wallet;
  }

  getPurchaseHistory(options?: {
    projectId?: string;
    startDate?: Date;
    endDate?: Date;
    category?: string;
  }): FinanceEntry[] {
    let entries = getFinanceEntries(options?.projectId);

    entries = entries.filter((e: FinanceEntry) => e.type === "expense");

    if (options?.startDate) {
      entries = entries.filter((e: FinanceEntry) => e.timestamp >= options.startDate!);
    }

    if (options?.endDate) {
      entries = entries.filter((e: FinanceEntry) => e.timestamp <= options.endDate!);
    }

    return entries;
  }

  getTotalExpenses(projectId?: string): number {
    const entries = getFinanceEntries(projectId);
    return entries
      .filter((e: FinanceEntry) => e.type === "expense")
      .reduce((sum, e: FinanceEntry) => sum + e.amount, 0);
  }

  getTotalIncome(projectId?: string): number {
    const entries = getFinanceEntries(projectId);
    return entries
      .filter((e: FinanceEntry) => e.type === "income")
      .reduce((sum, e: FinanceEntry) => sum + e.amount, 0);
  }

  private calculateTotalRevenue(): number {
    return this.getTotalIncome();
  }

  private async convertToUsd(amount: number, chain: ChainType): Promise<number> {
    const usdRates: Record<ChainType, number> = {
      BTC: 0,
      ETH: 0,
      SOL: 0,
    };

    try {
      if (chain === "BTC") {
        const response = await this.api.runtime.fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        );
        if (response.ok) {
          const data = (await response.json()) as { bitcoin: { usd: number } };
          usdRates.BTC = data.bitcoin?.usd || 0;
        }
      } else if (chain === "ETH") {
        const response = await this.api.runtime.fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
        );
        if (response.ok) {
          const data = (await response.json()) as { ethereum: { usd: number } };
          usdRates.ETH = data.ethereum?.usd || 0;
        }
      } else if (chain === "SOL") {
        const response = await this.api.runtime.fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        );
        if (response.ok) {
          const data = (await response.json()) as { solana: { usd: number } };
          usdRates.SOL = data.solana?.usd || 0;
        }
      }
    } catch (error) {
      this.api.logger.warn(`Finance: Failed to fetch USD rate for ${chain}`, error);
    }

    return amount * usdRates[chain];
  }

  private async updateWallets(): Promise<void> {
    const chains: ChainType[] = ["BTC", "ETH", "SOL"];

    for (const chain of chains) {
      try {
        const balance = await this.fetchChainBalance(chain);
        const wallets = getWallets().filter((w: Wallet) => w.chain === chain);

        if (wallets.length > 0) {
          const wallet = wallets[0];
          wallet.balance = balance;
          wallet.last_updated = new Date();
          saveWallet(wallet);
          this.api.logger.info(`Finance: ${chain} balance updated: ${balance}`);
        }
      } catch (error) {
        this.api.logger.warn(`Failed to update ${chain} balance`, error);
      }
    }
  }

  private async fetchChainBalance(chain: ChainType): Promise<number> {
    const wallets = getWallets().filter((w: Wallet) => w.chain === chain);

    if (wallets.length === 0) {
      return 0;
    }

    return wallets[0].balance;
  }
}

export default FinanceAgent;
