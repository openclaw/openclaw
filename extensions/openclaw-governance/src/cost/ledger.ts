// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Adapted from kelliott-cloud/Nexus-10.0-A under operator-granted re-license.
// Original: backend/routes/routes_admin_cost.py + cost_dashboard_helpers.py +
// the per-provider usage stamping in backend/governance/model_gateway.py.

import { randomUUID } from "node:crypto";
import type { CostEntryRow, GovernanceStore } from "../store/sqlite.js";

export type CostSummaryGroupBy = "session" | "skill" | "channel" | "model" | "day";

export type CostUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type CostRecordInput = {
  runId: string;
  sessionKey: string;
  provider: string;
  modelId: string;
  channelId?: string | null;
  skillId?: string | null;
  startedAtMs: number;
  endedAtMs: number;
  usage?: CostUsage;
  outputChars?: number;
  costUsdOverride?: number;
};

export type CostSummaryRow = {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  entries: number;
};

export type CostSummary = {
  groupBy: CostSummaryGroupBy;
  fromMs: number;
  toMs: number;
  rows: CostSummaryRow[];
  totals: Omit<CostSummaryRow, "key">;
};

export type PricePerMillion = {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd?: number;
  cacheWriteUsd?: number;
};

// Cache prices below are list-price approximations; operators with a custom
// rate card should override via CostLedgerOptions.pricesPerMillion.
const DEFAULT_PRICES: Record<string, PricePerMillion> = {
  "anthropic/claude-opus-4-8": {
    inputUsd: 15,
    outputUsd: 75,
    cacheReadUsd: 1.5,
    cacheWriteUsd: 18.75,
  },
  "anthropic/claude-opus-4-7": {
    inputUsd: 15,
    outputUsd: 75,
    cacheReadUsd: 1.5,
    cacheWriteUsd: 18.75,
  },
  "anthropic/claude-opus-4-6": {
    inputUsd: 15,
    outputUsd: 75,
    cacheReadUsd: 1.5,
    cacheWriteUsd: 18.75,
  },
  "anthropic/claude-sonnet-4-6": {
    inputUsd: 3,
    outputUsd: 15,
    cacheReadUsd: 0.3,
    cacheWriteUsd: 3.75,
  },
  "openai/gpt-5": { inputUsd: 1.25, outputUsd: 10, cacheReadUsd: 0.125, cacheWriteUsd: 0 },
  "openai/gpt-4o": { inputUsd: 2.5, outputUsd: 10, cacheReadUsd: 1.25, cacheWriteUsd: 0 },
  "openai/gpt-4o-mini": { inputUsd: 0.15, outputUsd: 0.6, cacheReadUsd: 0.075, cacheWriteUsd: 0 },
  "google/gemini-2.5-pro": {
    inputUsd: 1.25,
    outputUsd: 10,
    cacheReadUsd: 0.3125,
    cacheWriteUsd: 0,
  },
  "google/gemini-2.5-flash": {
    inputUsd: 0.3,
    outputUsd: 2.5,
    cacheReadUsd: 0.075,
    cacheWriteUsd: 0,
  },
};

export type CostLedgerOptions = {
  estimateFromChars?: boolean;
  pricesPerMillion?: Record<string, PricePerMillion>;
};

const CHARS_PER_OUTPUT_TOKEN = 4;

export class CostLedger {
  private readonly estimateFromChars: boolean;
  private readonly prices: Record<string, PricePerMillion>;

  constructor(
    private readonly store: GovernanceStore,
    opts: CostLedgerOptions = {},
  ) {
    this.estimateFromChars = opts.estimateFromChars ?? true;
    this.prices = { ...DEFAULT_PRICES, ...opts.pricesPerMillion };
  }

  private priceFor(provider: string, modelId: string): PricePerMillion | undefined {
    const direct = this.prices[`${provider}/${modelId}`];
    if (direct) {
      return direct;
    }
    return this.prices[modelId];
  }

  private deriveTokens(input: CostRecordInput): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    source: "provider" | "estimate";
  } {
    const usage = input.usage;
    if (
      usage &&
      ((usage.inputTokens ?? 0) > 0 ||
        (usage.outputTokens ?? 0) > 0 ||
        (usage.cacheReadTokens ?? 0) > 0 ||
        (usage.cacheWriteTokens ?? 0) > 0)
    ) {
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const cacheReadTokens = usage.cacheReadTokens ?? 0;
      const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
      return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        source: "provider",
      };
    }
    if (this.estimateFromChars && input.outputChars !== undefined && input.outputChars > 0) {
      const outputTokens = Math.max(1, Math.round(input.outputChars / CHARS_PER_OUTPUT_TOKEN));
      return {
        inputTokens: 0,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: outputTokens,
        source: "estimate",
      };
    }
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      source: "estimate",
    };
  }

  private computeCostUsd(
    input: CostRecordInput,
    tokens: ReturnType<CostLedger["deriveTokens"]>,
  ): number {
    if (input.costUsdOverride !== undefined && Number.isFinite(input.costUsdOverride)) {
      return Math.max(0, input.costUsdOverride);
    }
    const price = this.priceFor(input.provider, input.modelId);
    if (!price) {
      return 0;
    }
    const inputCost = (tokens.inputTokens / 1_000_000) * price.inputUsd;
    const outputCost = (tokens.outputTokens / 1_000_000) * price.outputUsd;
    const cacheReadCost = (tokens.cacheReadTokens / 1_000_000) * (price.cacheReadUsd ?? 0);
    const cacheWriteCost = (tokens.cacheWriteTokens / 1_000_000) * (price.cacheWriteUsd ?? 0);
    return Math.max(0, inputCost + outputCost + cacheReadCost + cacheWriteCost);
  }

  record(input: CostRecordInput): CostEntryRow {
    const tokens = this.deriveTokens(input);
    const costUsd = this.computeCostUsd(input, tokens);
    const row: CostEntryRow = {
      id: randomUUID(),
      runId: input.runId,
      sessionKey: input.sessionKey,
      provider: input.provider,
      modelId: input.modelId,
      channelId: input.channelId ?? null,
      skillId: input.skillId ?? null,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
      totalTokens: tokens.totalTokens,
      costUsd,
      source: tokens.source,
      startedAtMs: input.startedAtMs,
      endedAtMs: input.endedAtMs,
      createdAtMs: Date.now(),
    };
    this.store.insertCostEntry(row);
    return row;
  }

  getCostSummary(params: {
    from?: Date | number;
    to?: Date | number;
    groupBy: CostSummaryGroupBy;
  }): CostSummary {
    const fromMs =
      params.from === undefined
        ? 0
        : params.from instanceof Date
          ? params.from.getTime()
          : params.from;
    const toMs =
      params.to === undefined
        ? Number.MAX_SAFE_INTEGER
        : params.to instanceof Date
          ? params.to.getTime()
          : params.to;

    const entries = this.store.listCostEntries({ fromMs, toMs });
    const groupKeys = new Map<string, CostSummaryRow>();
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalTokens = 0;
    let totalCost = 0;

    for (const entry of entries) {
      let key: string;
      switch (params.groupBy) {
        case "session":
          key = entry.sessionKey;
          break;
        case "skill":
          key = entry.skillId ?? "(none)";
          break;
        case "channel":
          key = entry.channelId ?? "(none)";
          break;
        case "model":
          key = `${entry.provider}/${entry.modelId}`;
          break;
        case "day":
          key = new Date(entry.endedAtMs).toISOString().slice(0, 10);
          break;
        default:
          key = "(unknown)";
      }
      const existing = groupKeys.get(key);
      const next: CostSummaryRow = existing ?? {
        key,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        entries: 0,
      };
      next.inputTokens += entry.inputTokens;
      next.outputTokens += entry.outputTokens;
      next.cacheReadTokens += entry.cacheReadTokens;
      next.cacheWriteTokens += entry.cacheWriteTokens;
      next.totalTokens += entry.totalTokens;
      next.costUsd += entry.costUsd;
      next.entries += 1;
      groupKeys.set(key, next);

      totalInput += entry.inputTokens;
      totalOutput += entry.outputTokens;
      totalCacheRead += entry.cacheReadTokens;
      totalCacheWrite += entry.cacheWriteTokens;
      totalTokens += entry.totalTokens;
      totalCost += entry.costUsd;
    }

    const rows = Array.from(groupKeys.values()).toSorted((a, b) => b.costUsd - a.costUsd);
    return {
      groupBy: params.groupBy,
      fromMs,
      toMs,
      rows,
      totals: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheReadTokens: totalCacheRead,
        cacheWriteTokens: totalCacheWrite,
        totalTokens,
        costUsd: totalCost,
        entries: entries.length,
      },
    };
  }
}
