/**
 * subscription-verifier.ts — 15 天定期查驗引擎
 *
 * 規則：
 *   - 每 15 天自動觸發一次完整掃描
 *   - 比對上次記錄，找出「新增」、「消失」、「狀態變化」的訂閱
 *   - 對 API Key 訂閱：發出最小探針請求，確認 key 仍然有效
 *   - 查驗結果記錄到 verify-log.jsonl
 *   - 若發現變化：透過 OpenClaw logger 通知使用者（或寫入 pending-alerts.json）
 *
 * 觸發方式：
 *   1. 服務啟動時自動檢查（index.ts registerService start）
 *   2. CLI 手動：nuwa sub verify [--force]
 *   3. 外部 cron 或 OpenClaw 定時事件
 *
 * 探針策略（零成本，不消耗配額）：
 *   Anthropic  → GET /v1/models（免費，只驗 key 格式 + 回傳 200）
 *   OpenAI     → GET /v1/models（免費）
 *   Google     → GET /v1beta/models（免費）
 *   Mistral    → GET /v1/models（免費）
 *   Groq       → GET /openai/v1/models（免費）
 *   xAI        → GET /v1/models（免費）
 *   DeepSeek   → GET /v1/models（免費）
 *   Perplexity → key 格式驗證（無公開 models endpoint）
 *   Together   → GET /v1/models（免費）
 *   Cohere     → key 格式驗證
 *   Tavily     → key 格式驗證（避免消耗搜尋次數）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createAutoDetector, type DetectedProvider } from "./auto-detect.js";
import {
  createSubscriptionRegistry,
  fmtDate,
  SUBSCRIPTION_PLANS,
  type SubscriptionId,
  type ActiveSubscription,
} from "./subscription-registry.js";

// ─── 常數 ────────────────────────────────────────────────────────────

export const VERIFY_INTERVAL_DAYS = 15;
const VERIFY_INTERVAL_MS = VERIFY_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

// ─── 型別 ────────────────────────────────────────────────────────────

export type ProbeStatus = "valid" | "invalid" | "expired" | "rate_limited" | "unknown" | "skipped";

export type ProbeResult = {
  subscriptionId: SubscriptionId;
  status: ProbeStatus;
  httpStatus?: number;
  latencyMs?: number;
  detail: string;
};

export type VerifyDiff = {
  added: SubscriptionId[]; // 新偵測到（上次沒有）
  removed: SubscriptionId[]; // 不再偵測到（可能取消了）
  probeChanged: Array<{
    // Key 狀態變化
    id: SubscriptionId;
    before: ProbeStatus;
    after: ProbeStatus;
  }>;
  unchanged: SubscriptionId[];
};

export type VerifyRecord = {
  verifiedAt: string;
  triggeredBy: "scheduled" | "manual" | "startup";
  durationMs: number;
  detectedIds: SubscriptionId[];
  probeResults: ProbeResult[];
  diff: VerifyDiff;
  alerts: string[]; // 需要通知使用者的重要變化
};

type VerifyState = {
  lastVerifiedAt: string;
  lastDetectedIds: SubscriptionId[];
  lastProbeStatuses: Record<SubscriptionId, ProbeStatus>;
};

// ─── API 探針（全部用 models endpoint，零成本）────────────────────

async function probeAnthropic(apiKey?: string): Promise<ProbeResult> {
  const id: SubscriptionId = "claude-api-key";
  if (!apiKey && !process.env.ANTHROPIC_API_KEY) {
    return { subscriptionId: id, status: "skipped", detail: "無 API Key，跳過探針" };
  }
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY!;
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 200)
      return {
        subscriptionId: id,
        status: "valid",
        httpStatus: 200,
        latencyMs,
        detail: `Anthropic API Key 有效（${latencyMs}ms）`,
      };
    if (res.status === 401)
      return {
        subscriptionId: id,
        status: "invalid",
        httpStatus: 401,
        latencyMs,
        detail: "Anthropic API Key 無效或已撤銷",
      };
    if (res.status === 429)
      return {
        subscriptionId: id,
        status: "rate_limited",
        httpStatus: 429,
        latencyMs,
        detail: "Anthropic API 速率限制（Key 有效）",
      };
    return {
      subscriptionId: id,
      status: "unknown",
      httpStatus: res.status,
      latencyMs,
      detail: `Anthropic API 回傳 ${res.status}`,
    };
  } catch {
    return { subscriptionId: id, status: "unknown", detail: "探針請求逾時或網路錯誤" };
  }
}

async function probeOpenAI(apiKey?: string): Promise<ProbeResult> {
  const id: SubscriptionId = "openai-api-key";
  if (!apiKey && !process.env.OPENAI_API_KEY) {
    return { subscriptionId: id, status: "skipped", detail: "無 API Key，跳過探針" };
  }
  const key = apiKey ?? process.env.OPENAI_API_KEY!;
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 200)
      return {
        subscriptionId: id,
        status: "valid",
        httpStatus: 200,
        latencyMs,
        detail: `OpenAI API Key 有效（${latencyMs}ms）`,
      };
    if (res.status === 401)
      return {
        subscriptionId: id,
        status: "invalid",
        httpStatus: 401,
        latencyMs,
        detail: "OpenAI API Key 無效或已撤銷",
      };
    if (res.status === 429)
      return {
        subscriptionId: id,
        status: "rate_limited",
        httpStatus: 429,
        latencyMs,
        detail: "OpenAI API 速率限制（Key 有效）",
      };
    return {
      subscriptionId: id,
      status: "unknown",
      httpStatus: res.status,
      latencyMs,
      detail: `OpenAI API 回傳 ${res.status}`,
    };
  } catch {
    return { subscriptionId: id, status: "unknown", detail: "探針逾時或網路錯誤" };
  }
}

async function probeGoogle(apiKey?: string): Promise<ProbeResult> {
  const id: SubscriptionId = "gemini-api-key";
  const key = apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!key) return { subscriptionId: id, status: "skipped", detail: "無 API Key，跳過探針" };
  const t0 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 200)
      return {
        subscriptionId: id,
        status: "valid",
        httpStatus: 200,
        latencyMs,
        detail: `Gemini API Key 有效（${latencyMs}ms）`,
      };
    if (res.status === 400 || res.status === 403)
      return {
        subscriptionId: id,
        status: "invalid",
        httpStatus: res.status,
        latencyMs,
        detail: "Gemini API Key 無效",
      };
    return {
      subscriptionId: id,
      status: "unknown",
      httpStatus: res.status,
      latencyMs,
      detail: `Gemini API 回傳 ${res.status}`,
    };
  } catch {
    return { subscriptionId: id, status: "unknown", detail: "探針逾時或網路錯誤" };
  }
}

async function probeMistral(apiKey?: string): Promise<ProbeResult> {
  const id: SubscriptionId = "mistral-api-key";
  const key = apiKey ?? process.env.MISTRAL_API_KEY;
  if (!key) return { subscriptionId: id, status: "skipped", detail: "無 API Key，跳過探針" };
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.mistral.ai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 200)
      return {
        subscriptionId: id,
        status: "valid",
        httpStatus: 200,
        latencyMs,
        detail: `Mistral API Key 有效（${latencyMs}ms）`,
      };
    if (res.status === 401)
      return {
        subscriptionId: id,
        status: "invalid",
        httpStatus: 401,
        latencyMs,
        detail: "Mistral API Key 無效",
      };
    return {
      subscriptionId: id,
      status: "unknown",
      httpStatus: res.status,
      latencyMs,
      detail: `Mistral API 回傳 ${res.status}`,
    };
  } catch {
    return { subscriptionId: id, status: "unknown", detail: "探針逾時" };
  }
}

async function probeGroq(apiKey?: string): Promise<ProbeResult> {
  const id: SubscriptionId = "groq-api-key";
  const key = apiKey ?? process.env.GROQ_API_KEY;
  if (!key)
    return { subscriptionId: id, status: "skipped", detail: "無 API Key（免費層無需驗證）" };
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 200)
      return {
        subscriptionId: id,
        status: "valid",
        httpStatus: 200,
        latencyMs,
        detail: `Groq API Key 有效（${latencyMs}ms）`,
      };
    if (res.status === 401)
      return {
        subscriptionId: id,
        status: "invalid",
        httpStatus: 401,
        latencyMs,
        detail: "Groq API Key 無效",
      };
    return {
      subscriptionId: id,
      status: "unknown",
      httpStatus: res.status,
      latencyMs,
      detail: `Groq API 回傳 ${res.status}`,
    };
  } catch {
    return { subscriptionId: id, status: "unknown", detail: "探針逾時" };
  }
}

async function probeXAI(apiKey?: string): Promise<ProbeResult> {
  const id: SubscriptionId = "xai-api-key";
  const key = apiKey ?? process.env.XAI_API_KEY;
  if (!key) return { subscriptionId: id, status: "skipped", detail: "無 API Key" };
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 200)
      return {
        subscriptionId: id,
        status: "valid",
        httpStatus: 200,
        latencyMs,
        detail: `xAI API Key 有效（${latencyMs}ms）`,
      };
    if (res.status === 401)
      return {
        subscriptionId: id,
        status: "invalid",
        httpStatus: 401,
        latencyMs,
        detail: "xAI API Key 無效",
      };
    return {
      subscriptionId: id,
      status: "unknown",
      httpStatus: res.status,
      latencyMs,
      detail: `xAI API 回傳 ${res.status}`,
    };
  } catch {
    return { subscriptionId: id, status: "unknown", detail: "探針逾時" };
  }
}

async function probeDeepSeek(apiKey?: string): Promise<ProbeResult> {
  const id: SubscriptionId = "deepseek-api-key";
  const key = apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!key) return { subscriptionId: id, status: "skipped", detail: "無 API Key" };
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.deepseek.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 200)
      return {
        subscriptionId: id,
        status: "valid",
        httpStatus: 200,
        latencyMs,
        detail: `DeepSeek API Key 有效（${latencyMs}ms）`,
      };
    if (res.status === 401)
      return {
        subscriptionId: id,
        status: "invalid",
        httpStatus: 401,
        latencyMs,
        detail: "DeepSeek API Key 無效",
      };
    return {
      subscriptionId: id,
      status: "unknown",
      httpStatus: res.status,
      latencyMs,
      detail: `DeepSeek API 回傳 ${res.status}`,
    };
  } catch {
    return { subscriptionId: id, status: "unknown", detail: "探針逾時" };
  }
}

async function probeTogether(apiKey?: string): Promise<ProbeResult> {
  const id: SubscriptionId = "together-api-key";
  const key = apiKey ?? process.env.TOGETHER_API_KEY ?? process.env.TOGETHERAI_API_KEY;
  if (!key) return { subscriptionId: id, status: "skipped", detail: "無 API Key" };
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.together.xyz/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (res.status === 200)
      return {
        subscriptionId: id,
        status: "valid",
        httpStatus: 200,
        latencyMs,
        detail: `Together AI Key 有效（${latencyMs}ms）`,
      };
    if (res.status === 401)
      return {
        subscriptionId: id,
        status: "invalid",
        httpStatus: 401,
        latencyMs,
        detail: "Together AI Key 無效",
      };
    return {
      subscriptionId: id,
      status: "unknown",
      httpStatus: res.status,
      latencyMs,
      detail: `Together AI API 回傳 ${res.status}`,
    };
  } catch {
    return { subscriptionId: id, status: "unknown", detail: "探針逾時" };
  }
}

/** 格式驗證型探針（不消耗配額）*/
function probeByKeyFormat(
  id: SubscriptionId,
  key: string | undefined,
  prefix: string,
  detail: string,
): ProbeResult {
  if (!key) return { subscriptionId: id, status: "skipped", detail: `無 API Key，跳過` };
  const valid = key.startsWith(prefix) && key.length > 20;
  return {
    subscriptionId: id,
    status: valid ? "valid" : "invalid",
    detail: valid ? `${detail} Key 格式正確` : `${detail} Key 格式異常（預期前綴：${prefix}）`,
  };
}

// ─── 主查驗引擎 ──────────────────────────────────────────────────────

export class SubscriptionVerifier {
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly logPath: string;
  private readonly alertPath: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.statePath = path.join(stateDir, "verify-state.json");
    this.logPath = path.join(stateDir, "verify-log.jsonl");
    this.alertPath = path.join(stateDir, "pending-alerts.json");
  }

  // ── 檢查是否需要查驗 ────────────────────────────────────────────

  async isDue(): Promise<{ due: boolean; lastVerifiedAt: string | null; nextDue: string }> {
    const state = await this.loadState();
    if (!state) {
      return { due: true, lastVerifiedAt: null, nextDue: new Date().toISOString() };
    }
    const last = new Date(state.lastVerifiedAt);
    const next = new Date(last.getTime() + VERIFY_INTERVAL_MS);
    const due = Date.now() >= next.getTime();
    return { due, lastVerifiedAt: state.lastVerifiedAt, nextDue: next.toISOString() };
  }

  // ── 執行查驗（主流程）───────────────────────────────────────────

  async verify(
    triggeredBy: VerifyRecord["triggeredBy"] = "scheduled",
    opts: { silent?: boolean } = {},
  ): Promise<VerifyRecord> {
    const t0 = Date.now();
    if (!opts.silent) process.stderr.write(`🔍 [nuwa] 執行 15 天定期訂閱查驗...\n`);

    // 1. 重新掃描（強制，不用快取）
    const detector = createAutoDetector(this.stateDir);
    const detection = await detector.detect(true);
    const detectedIds = detection.providers
      .filter((p) => p.confidence !== "possible")
      .map((p) => p.subscriptionId);

    // 2. 對每個有 API Key 的訂閱發探針
    const probeResults = await this.runProbes(detectedIds);

    // 3. 與上次比對
    const state = await this.loadState();
    const diff = this.computeDiff(
      state?.lastDetectedIds ?? [],
      detectedIds,
      state?.lastProbeStatuses ?? {},
      probeResults,
    );

    // 4. 生成警報
    const alerts = this.generateAlerts(diff, probeResults);

    const record: VerifyRecord = {
      verifiedAt: new Date().toISOString(),
      triggeredBy,
      durationMs: Date.now() - t0,
      detectedIds,
      probeResults,
      diff,
      alerts,
    };

    // 5. 更新狀態與日誌
    await this.saveState({
      lastVerifiedAt: record.verifiedAt,
      lastDetectedIds: detectedIds,
      lastProbeStatuses: Object.fromEntries(
        probeResults.map((r) => [r.subscriptionId, r.status]),
      ) as Record<SubscriptionId, ProbeStatus>,
    });
    await this.appendLog(record);

    // 6. 若有警報，寫入 pending-alerts.json
    if (alerts.length > 0) {
      await this.savePendingAlerts(alerts, record.verifiedAt);
      if (!opts.silent) {
        for (const alert of alerts) {
          process.stderr.write(`⚠️  [nuwa] ${alert}\n`);
        }
      }
    }

    // 7. 把新偵測結果同步進 SubscriptionRegistry
    await this.syncToRegistry(detectedIds);

    if (!opts.silent) {
      process.stderr.write(
        `✅ [nuwa] 查驗完成（${record.durationMs}ms）：` +
          `${detectedIds.length} 個訂閱，${alerts.length} 個警報\n`,
      );
    }

    return record;
  }

  // ── 啟動時自動觸發（如果距上次超過 15 天）─────────────────────

  async checkAndRunIfDue(): Promise<void> {
    const { due, nextDue } = await this.isDue();
    if (due) {
      await this.verify("scheduled", { silent: false });
    } else {
      const next = new Date(nextDue);
      process.stderr.write(
        `[nuwa] 訂閱查驗：下次 ${fmtDate(next)}（${VERIFY_INTERVAL_DAYS} 天週期）\n`,
      );
    }
  }

  // ── 探針（並行執行，限時 10 秒）────────────────────────────────

  private async runProbes(ids: SubscriptionId[]): Promise<ProbeResult[]> {
    const reg = createSubscriptionRegistry(this.stateDir);
    const file = await reg.load();

    const getKey = (id: SubscriptionId): string | undefined =>
      file.subscriptions.find((s) => s.id === id)?.apiKey;

    const probers: Array<() => Promise<ProbeResult>> = [];

    for (const id of ids) {
      const plan = SUBSCRIPTION_PLANS[id];
      if (!plan?.isApiKeyMode) continue; // 只探針 API Key 類型

      switch (id) {
        case "claude-api-key":
          probers.push(() => probeAnthropic(getKey(id)));
          break;
        case "openai-api-key":
          probers.push(() => probeOpenAI(getKey(id)));
          break;
        case "codex-cli-key":
          probers.push(() => probeOpenAI(getKey(id)));
          break;
        case "gemini-api-key":
          probers.push(() => probeGoogle(getKey(id)));
          break;
        case "vertex-ai-key":
          probers.push(() => probeGoogle(getKey(id)));
          break;
        case "mistral-api-key":
          probers.push(() => probeMistral(getKey(id)));
          break;
        case "mistral-la-plateforme-free":
          probers.push(() => probeMistral(getKey(id)));
          break;
        case "groq-api-key":
          probers.push(() => probeGroq(getKey(id)));
          break;
        case "xai-api-key":
          probers.push(() => probeXAI(getKey(id)));
          break;
        case "deepseek-api-key":
          probers.push(() => probeDeepSeek(getKey(id)));
          break;
        case "together-api-key":
          probers.push(() => probeTogether(getKey(id)));
          break;
        case "perplexity-api-key":
          probers.push(() =>
            Promise.resolve(
              probeByKeyFormat(
                id,
                getKey(id) ?? process.env.PERPLEXITY_API_KEY,
                "pplx-",
                "Perplexity",
              ),
            ),
          );
          break;
        case "cohere-api-key":
          probers.push(() =>
            Promise.resolve(
              probeByKeyFormat(id, getKey(id) ?? process.env.COHERE_API_KEY, "", "Cohere"),
            ),
          );
          break;
        case "tavily-api-key":
          probers.push(() =>
            Promise.resolve(
              probeByKeyFormat(id, getKey(id) ?? process.env.TAVILY_API_KEY, "tvly-", "Tavily"),
            ),
          );
          break;
      }
    }

    const results = await Promise.allSettled(probers.map((fn) => fn()));
    return results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((r): r is ProbeResult => r !== null);
  }

  // ── diff 計算 ────────────────────────────────────────────────────

  private computeDiff(
    before: SubscriptionId[],
    after: SubscriptionId[],
    beforeStatuses: Record<SubscriptionId, ProbeStatus>,
    afterProbes: ProbeResult[],
  ): VerifyDiff {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const afterStatusMap = Object.fromEntries(
      afterProbes.map((r) => [r.subscriptionId, r.status]),
    ) as Record<SubscriptionId, ProbeStatus>;

    const added = after.filter((id) => !beforeSet.has(id));
    const removed = before.filter((id) => !afterSet.has(id));
    const unchanged = after.filter((id) => beforeSet.has(id));

    const probeChanged: VerifyDiff["probeChanged"] = [];
    for (const id of unchanged) {
      const b = beforeStatuses[id];
      const a = afterStatusMap[id];
      if (b && a && b !== a) {
        probeChanged.push({ id, before: b, after: a });
      }
    }

    return { added, removed, probeChanged, unchanged };
  }

  // ── 警報生成 ────────────────────────────────────────────────────

  private generateAlerts(diff: VerifyDiff, probes: ProbeResult[]): string[] {
    const alerts: string[] = [];

    for (const id of diff.added) {
      alerts.push(`新訂閱偵測到：${id}（${SUBSCRIPTION_PLANS[id]?.displayName ?? id}）`);
    }

    for (const id of diff.removed) {
      const plan = SUBSCRIPTION_PLANS[id];
      if (plan && plan.monthlyUsd > 0) {
        alerts.push(
          `⚠️  付費訂閱消失：${plan.displayName}（$${plan.monthlyUsd}/月）— 可能已取消或設定被移除`,
        );
      } else {
        alerts.push(`訂閱不再偵測到：${id}`);
      }
    }

    for (const { id, before, after } of diff.probeChanged) {
      if (after === "invalid" || after === "expired") {
        alerts.push(`🚨 API Key 失效：${id} — 狀態從 ${before} 變為 ${after}，請更新 Key`);
      } else if (before === "invalid" && after === "valid") {
        alerts.push(`✅ API Key 恢復有效：${id}`);
      }
    }

    // 直接從探針結果找失效的
    for (const probe of probes) {
      if (probe.status === "invalid") {
        alerts.push(`🚨 API Key 無效：${probe.subscriptionId} — ${probe.detail}`);
      }
    }

    return alerts;
  }

  // ── 同步到 SubscriptionRegistry ─────────────────────────────────

  private async syncToRegistry(detectedIds: SubscriptionId[]): Promise<void> {
    const reg = createSubscriptionRegistry(this.stateDir);
    // 只新增本次偵測到但尚未登記的訂閱；
    // 已存在的項目保持不動（特別是 addedAt 計費週期錨點）。
    const file = await reg.load();
    const existingIds = new Set(file.subscriptions.map((s) => s.id));
    for (const id of detectedIds) {
      if (!existingIds.has(id)) {
        await reg.add(id, { note: "15 天查驗同步（新增）" }).catch(() => {});
      }
    }
  }

  // ── 狀態持久化 ───────────────────────────────────────────────────

  private async loadState(): Promise<VerifyState | null> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      return JSON.parse(raw) as VerifyState;
    } catch {
      return null;
    }
  }

  private async saveState(state: VerifyState): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  private async appendLog(record: VerifyRecord): Promise<void> {
    await fs.appendFile(this.logPath, JSON.stringify(record) + "\n", "utf8");
  }

  private async savePendingAlerts(alerts: string[], verifiedAt: string): Promise<void> {
    await fs.writeFile(this.alertPath, JSON.stringify({ verifiedAt, alerts }, null, 2), "utf8");
  }

  // ── 讀取待處理警報（給啟動時顯示）──────────────────────────────

  async getPendingAlerts(): Promise<{ verifiedAt: string; alerts: string[] } | null> {
    try {
      const raw = await fs.readFile(this.alertPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async clearPendingAlerts(): Promise<void> {
    try {
      await fs.unlink(this.alertPath);
    } catch {
      /* 不存在 */
    }
  }

  // ── 查驗歷史 ────────────────────────────────────────────────────

  async readLog(limit = 10): Promise<VerifyRecord[]> {
    try {
      const raw = await fs.readFile(this.logPath, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => JSON.parse(l) as VerifyRecord)
        .reverse();
    } catch {
      return [];
    }
  }

  // ── 格式化查驗報告 ───────────────────────────────────────────────

  async formatReport(record: VerifyRecord): Promise<string> {
    const lines = [
      `🔍 訂閱查驗報告`,
      `   時間：${new Date(record.verifiedAt).toLocaleString("zh-TW")}`,
      `   觸發：${record.triggeredBy === "scheduled" ? "15 天定期" : record.triggeredBy === "manual" ? "手動" : "啟動時"}`,
      `   耗時：${record.durationMs}ms`,
      ``,
    ];

    if (record.diff.added.length > 0) {
      lines.push(`📥 新增訂閱（${record.diff.added.length} 個）：`);
      for (const id of record.diff.added) {
        lines.push(`   ➕ ${id}  ${SUBSCRIPTION_PLANS[id]?.displayName ?? ""}`);
      }
      lines.push("");
    }

    if (record.diff.removed.length > 0) {
      lines.push(`📤 消失的訂閱（${record.diff.removed.length} 個）：`);
      for (const id of record.diff.removed) {
        lines.push(`   ➖ ${id}  ${SUBSCRIPTION_PLANS[id]?.displayName ?? ""}`);
      }
      lines.push("");
    }

    if (record.probeResults.length > 0) {
      lines.push(`🌐 API Key 探針結果：`);
      const icons: Record<ProbeStatus, string> = {
        valid: "✅",
        invalid: "❌",
        expired: "⏰",
        rate_limited: "⚡",
        unknown: "❓",
        skipped: "⏭️",
      };
      for (const probe of record.probeResults) {
        lines.push(
          `   ${icons[probe.status]} ${probe.subscriptionId.padEnd(28)} ${probe.detail}` +
            (probe.latencyMs ? ` (${probe.latencyMs}ms)` : ""),
        );
      }
      lines.push("");
    }

    if (record.alerts.length > 0) {
      lines.push(`⚠️  警報（${record.alerts.length} 個）：`);
      for (const a of record.alerts) lines.push(`   ${a}`);
    } else {
      lines.push(`✅ 無異常，所有訂閱狀態正常`);
    }

    return lines.join("\n");
  }
}

export function createSubscriptionVerifier(stateDir: string): SubscriptionVerifier {
  return new SubscriptionVerifier(stateDir);
}
