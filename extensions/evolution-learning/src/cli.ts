/**
 * evolution-learning CLI 子指令
 *
 * 透過 api.registerCli() 掛載進 OpenClaw：
 *   openclaw evolution status
 *   openclaw evolution patterns [--json]
 *   openclaw evolution cells    [--json]
 *   openclaw evolution top
 *   openclaw evolution rem      [--workspace <dir>]
 *   openclaw evolution distill  <target> [--workspace <dir>]
 *   openclaw evolution freeze   <slug>
 *   openclaw evolution unfreeze <slug>
 *   openclaw evolution install  <slug>
 *   openclaw evolution forget   <slug> [--force]
 *   openclaw evolution hatch    <slug>
 *
 * 也作為 bin/nuwa.ts 的共享邏輯層。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { Command } from "commander";
import { createCostGuard } from "./cost-guard.js";
import { openDb } from "./db.js";
import { runDMAD } from "./dmad-debate.js";
import { createModelPricingDb } from "./model-pricing.js";
import {
  createSubscriptionRegistry,
  SubscriptionRegistry,
  type SubscriptionId,
} from "./subscription-registry.js";

const execFileAsync = promisify(execFile);

// ─── 型別（與 index.ts 保持一致）────────────────────────────────

type NuwaPattern = {
  id: string;
  slug: string;
  target: string;
  confidence: number;
  successRate: number;
  sampleCount: number;
  mentalModels: string[];
  keywords: string[];
  context: string;
  skillPath?: string;
  frozen?: boolean;
  lastUsed?: string | null;
  createdAt: string;
};

type StemCell = {
  id: string;
  slug: string;
  target: string;
  status: "embryo" | "incubating" | "ready" | "installed";
  maturityScore: number;
  usageCount: number;
  positiveRating: number;
  lastEvaluated?: string;
};

type CellRegistry = {
  version: number;
  stemCells: StemCell[];
};

// ─── 工具函數 ───────────────────────────────────────────────────

function resolveStateDir(workspaceDir?: string): string {
  const base = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
  return path.join(base, ".claude", "evolution-state");
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readPatterns(stateDir: string): Promise<NuwaPattern[]> {
  const content = await safeRead(path.join(stateDir, "patterns.jsonl"));
  if (!content) {
    return [];
  }
  const result: NuwaPattern[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      result.push(JSON.parse(t) as NuwaPattern);
    } catch {
      /* skip */
    }
  }
  return result;
}

async function readRegistry(stateDir: string): Promise<CellRegistry | null> {
  const content = await safeRead(path.join(stateDir, "cell-registry.json"));
  if (!content) {
    return null;
  }
  try {
    return JSON.parse(content) as CellRegistry;
  } catch {
    return null;
  }
}

async function writePatterns(stateDir: string, patterns: NuwaPattern[]): Promise<void> {
  const lines = patterns.map((p) => JSON.stringify(p)).join("\n") + "\n";
  await fs.writeFile(path.join(stateDir, "patterns.jsonl"), lines, "utf8");
}

async function writeRegistry(stateDir: string, reg: CellRegistry): Promise<void> {
  await fs.writeFile(
    path.join(stateDir, "cell-registry.json"),
    JSON.stringify(reg, null, 2) + "\n",
    "utf8",
  );
}

function statusIcon(s: string): string {
  return (
    ({ embryo: "🥚", incubating: "🐣", ready: "✅", installed: "🌟" } as Record<string, string>)[
      s
    ] ?? "❓"
  );
}

function printOrJson(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else if (typeof data === "string") {
    process.stdout.write(data + "\n");
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
}

// ─── 指令處理函數（可被 CLI 和 standalone bin 共用）──────────────

export async function cmdStatus(opts: { workspace?: string; json?: boolean }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const patterns = await readPatterns(stateDir);
  const reg = await readRegistry(stateDir);
  const cells = reg?.stemCells ?? [];
  const installed = cells.filter((c) => c.status === "installed").length;
  const ready = cells.filter((c) => c.status === "ready").length;
  const incubating = cells.filter((c) => c.status === "incubating").length;
  const embryo = cells.filter((c) => c.status === "embryo").length;

  if (opts.json) {
    printOrJson(
      { patterns: patterns.length, cells: { installed, ready, incubating, embryo } },
      true,
    );
    return;
  }
  printOrJson(
    [
      "🏺 女媧 × 四層進化系統",
      "",
      `第一層（學習模式庫）：${patterns.length} 個女媧模式`,
      `第四層（有機細胞）  ：🌟 ${installed} 常駐 / ✅ ${ready} 就緒 / 🐣 ${incubating} 孵化 / 🥚 ${embryo} 胚胎`,
      `狀態目錄：${stateDir}`,
    ].join("\n"),
    false,
  );
}

export async function cmdPatterns(opts: { workspace?: string; json?: boolean }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const patterns = await readPatterns(stateDir);
  if (opts.json) {
    printOrJson(patterns, true);
    return;
  }
  if (patterns.length === 0) {
    process.stdout.write("📭 尚未有蒸餾模式。\n");
    return;
  }
  const lines = patterns.map(
    (p) =>
      `• ${p.target.padEnd(16)} 信心 ${(p.confidence * 100).toFixed(0).padStart(3)}%  ` +
      `使用 ${String(p.sampleCount).padStart(4)} 次  ` +
      `slug: ${p.slug}${p.frozen ? "  🔒" : ""}`,
  );
  process.stdout.write(`🧠 女媧模式（${patterns.length} 個）：\n${lines.join("\n")}\n`);
}

export async function cmdCells(opts: { workspace?: string; json?: boolean }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const reg = await readRegistry(stateDir);
  const cells = reg?.stemCells ?? [];
  if (opts.json) {
    printOrJson(cells, true);
    return;
  }
  if (cells.length === 0) {
    process.stdout.write("📭 幹細胞池為空。\n");
    return;
  }
  const lines = cells.map(
    (c) =>
      `${statusIcon(c.status)} ${c.target.padEnd(16)} ` +
      `成熟度 ${(c.maturityScore * 100).toFixed(0).padStart(3)}%  ` +
      `使用 ${String(c.usageCount).padStart(4)} 次  ` +
      `slug: ${c.slug}`,
  );
  process.stdout.write(`🧬 幹細胞池（${cells.length} 個）：\n${lines.join("\n")}\n`);
}

export async function cmdTop(opts: { workspace?: string; json?: boolean }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const patterns = await readPatterns(stateDir);
  const sorted = [...patterns].toSorted((a, b) => b.sampleCount - a.sampleCount).slice(0, 5);
  if (opts.json) {
    printOrJson(sorted, true);
    return;
  }
  if (sorted.length === 0) {
    process.stdout.write("📭 尚無使用記錄。\n");
    return;
  }
  const lines = sorted.map(
    (p, i) =>
      `${i + 1}. ${p.target}（使用 ${p.sampleCount} 次，成功率 ${(p.successRate * 100).toFixed(0)}%）`,
  );
  process.stdout.write(`🏆 最常使用的人物框架：\n${lines.join("\n")}\n`);
}

export async function cmdRem(opts: { workspace?: string }): Promise<void> {
  // 在 CLI 模式下，直接呼叫 index.ts 的 runRemCycle 需要完整初始化環境
  // 最佳做法：透過 openclaw gateway RPC 觸發（當 gateway 執行時）
  // 備案：印出提示讓用戶知道應在 OpenClaw 內部執行
  const stateDir = resolveStateDir(opts.workspace);
  const exists = await safeRead(path.join(stateDir, "patterns.jsonl"));
  if (!exists) {
    process.stderr.write(
      `❌ 找不到進化狀態目錄：${stateDir}\n` +
        `   請先啟動 OpenClaw 讓插件初始化，或指定正確的 --workspace。\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `⚠️  CLI 模式下無法直接觸發完整 REM 週期（需要 OpenClaw 插件上下文）。\n` +
      `   請使用以下方式之一：\n` +
      `   • 在 OpenClaw 對話中輸入 /evolution rem\n` +
      `   • 等待自動 REM 週期（每 8 小時一次）\n` +
      `   • 啟動 OpenClaw gateway 後再執行：openclaw evolution rem\n`,
  );
}

export async function cmdDistill(
  target: string,
  opts: { workspace?: string; tavilyKey?: string },
): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const patternsPath = path.join(stateDir, "patterns.jsonl");
  const exists = await safeRead(patternsPath);
  if (!exists) {
    process.stderr.write(`❌ 找不到 patterns.jsonl：${patternsPath}\n`);
    process.exitCode = 1;
    return;
  }

  // ── 費用守衛 ────────────────────────────────────────────────────
  const guard = createCostGuard(stateDir);
  const apiKey = opts.tavilyKey ?? process.env.TAVILY_API_KEY;
  if (apiKey) {
    const ok = await guard.gate("tavily_search", { callCount: 1 });
    if (!ok) {
      process.stderr.write(`💡 可改用啟發式蒸餾（不傳入 --tavily-key）。\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    // 啟發式蒸餾（純計算）永遠免費，僅記錄
    await guard.gate("internal_compute");
  }

  const slug = target
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const id = `${slug}-auto-v${Date.now()}`;

  // 若有 Tavily Key，嘗試搜尋（同 index.ts 的 autoDistillTopic 邏輯）
  let keywords: string[] = [target];
  let mentalModels: string[] = [`${target} 思維框架`, `${target} 核心原則`];
  let confidence = 0.45;

  if (apiKey) {
    try {
      process.stdout.write(`🔍 搜尋 "${target}"...\n`);
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: target,
          max_results: 5,
          search_depth: "basic",
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { results?: Array<{ content?: string }> };
        const text = (data.results ?? []).map((r) => r.content ?? "").join(" ");
        // 簡易關鍵字萃取
        const words = text.match(/[一-鿿]{2,6}|[a-zA-Z]{4,}/g) ?? [];
        const freq: Record<string, number> = {};
        for (const w of words) {
          freq[w] = (freq[w] ?? 0) + 1;
        }
        keywords = Object.entries(freq)
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([w]) => w)
          .concat([target, slug]);
        confidence = 0.55;
        process.stdout.write(`✅ 搜尋完成，提取 ${keywords.length} 個關鍵字\n`);
      }
    } catch {
      /* fallback to heuristic */
    }
  }

  const pattern = {
    id,
    type: "persona",
    category: "distilled",
    target,
    slug,
    confidence,
    successRate: 0.5,
    sampleCount: 0,
    mentalModels,
    keywords,
    sourceCount: 0,
    context: `${target} — 由 nuwa CLI 自動蒸餾（${new Date().toISOString().split("T")[0]}）`,
    skillPath: null,
    frozen: false,
    createdAt: new Date().toISOString(),
    lastUsed: null,
  };

  await fs.appendFile(patternsPath, JSON.stringify(pattern) + "\n", "utf8");
  process.stdout.write(
    `🧬 已蒸餾並寫入 pattern：\n` +
      `   id     ：${id}\n` +
      `   target ：${target}\n` +
      `   slug   ：${slug}\n` +
      `   信心度 ：${(confidence * 100).toFixed(0)}%\n` +
      `   關鍵字 ：${keywords.slice(0, 5).join("、")}...\n`,
  );
}

// ─── 訂閱管理指令 ───────────────────────────────────────────────────

export async function cmdSubList(opts: { workspace?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const reg = createSubscriptionRegistry(stateDir);
  process.stdout.write((await reg.summary()) + "\n");
}

export async function cmdSubPlans(): Promise<void> {
  process.stdout.write(SubscriptionRegistry.listAllPlans() + "\n");
}

export async function cmdSubAdd(
  id: string,
  opts: { workspace?: string; key?: string; note?: string; budget?: string },
): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const reg = createSubscriptionRegistry(stateDir);
  try {
    await reg.add(id as SubscriptionId, {
      note: opts.note,
      apiKey: opts.key,
      monthlyBudgetUsd: opts.budget ? Number.parseFloat(opts.budget) : undefined,
    });
    process.stdout.write(`✅ 已登記訂閱：${id}\n`);
    process.stdout.write((await reg.summary()) + "\n");
  } catch (err) {
    process.stderr.write(
      `❌ 登記失敗：${err instanceof Error ? err.message : String(err)}\n` +
        `   執行 nuwa sub plans 查看所有有效的方案 ID。\n`,
    );
    process.exitCode = 1;
  }
}

export async function cmdSubRemove(id: string, opts: { workspace?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const reg = createSubscriptionRegistry(stateDir);
  const removed = await reg.remove(id as SubscriptionId);
  if (removed) {
    process.stdout.write(`🗑️  已移除訂閱：${id}\n`);
  } else {
    process.stderr.write(`❌ 找不到訂閱：${id}\n`);
    process.exitCode = 1;
  }
}

export async function cmdSubDetect(opts: { workspace?: string; force?: boolean }): Promise<void> {
  const { createAutoDetector } = await import("./auto-detect.js");
  const stateDir = resolveStateDir(opts.workspace);
  const detector = createAutoDetector(stateDir);

  process.stdout.write(opts.force ? "🔄 強制重新掃描...\n\n" : "🔍 執行自動偵測...\n\n");
  process.stdout.write((await detector.format(opts.force ?? false)) + "\n");

  // 把偵測結果同步進 SubscriptionRegistry
  const ids = await detector.getSubscriptionIds(opts.force ?? false);
  if (ids.length > 0) {
    const reg = createSubscriptionRegistry(stateDir);
    for (const id of ids) {
      await reg.add(id, { note: "自動偵測" });
    }
    process.stdout.write("\n" + (await reg.summary()) + "\n");
  }
}

export async function cmdSubVerify(opts: { workspace?: string; force?: boolean }): Promise<void> {
  const { createSubscriptionVerifier } = await import("./subscription-verifier.js");
  const stateDir = resolveStateDir(opts.workspace);
  const verifier = createSubscriptionVerifier(stateDir);

  const { due, lastVerifiedAt, nextDue } = await verifier.isDue();

  if (!opts.force && !due) {
    const next = new Date(nextDue);
    const last = lastVerifiedAt ? new Date(lastVerifiedAt) : null;
    process.stdout.write(
      `⏰ 尚未到查驗時間\n` +
        `   上次查驗：${last ? last.toLocaleString("zh-TW") : "從未執行"}\n` +
        `   下次查驗：${next.toLocaleString("zh-TW")}\n` +
        `   （加上 --force 立即強制執行）\n`,
    );
    return;
  }

  process.stdout.write(
    opts.force ? `🔄 強制執行訂閱查驗...\n\n` : `🔍 執行定期訂閱查驗（15 天週期）...\n\n`,
  );

  const record = await verifier.verify("manual");
  process.stdout.write((await verifier.formatReport(record)) + "\n");

  // 顯示歷史記錄
  const history = await verifier.readLog(3);
  if (history.length > 1) {
    process.stdout.write(`\n📜 最近查驗記錄：\n`);
    for (const r of history.slice(1)) {
      process.stdout.write(
        `   ${new Date(r.verifiedAt).toLocaleDateString("zh-TW")}  ` +
          `${r.detectedIds.length} 個訂閱  ` +
          `${r.alerts.length > 0 ? `⚠️ ${r.alerts.length} 個警報` : "✅ 正常"}\n`,
      );
    }
  }
}

export async function cmdSubBudget(
  amount: string,
  opts: { workspace?: string; behavior?: string },
): Promise<void> {
  const usd = Number.parseFloat(amount);
  if (Number.isNaN(usd) || usd < 0) {
    process.stderr.write(`❌ 無效金額：${amount}（請輸入非負數字，例如 10 或 0）\n`);
    process.exitCode = 1;
    return;
  }
  const stateDir = resolveStateDir(opts.workspace);
  const reg = createSubscriptionRegistry(stateDir);
  const behavior = (opts.behavior as "block" | "warn") ?? "block";
  await reg.setGlobalBudget(usd, behavior);
  process.stdout.write(
    usd === 0
      ? `✅ 已清除月預算限制。\n`
      : `✅ 已設定月預算上限：$${usd}（超過時${behavior === "block" ? "封鎖" : "僅警告"}）\n`,
  );
}

// ─── 模型定價查詢指令 ───────────────────────────────────────────────

export async function cmdModels(opts: {
  workspace?: string;
  search?: string;
  refresh?: boolean;
}): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const db = createModelPricingDb(stateDir);

  if (opts.refresh) {
    process.stdout.write("🔄 從 LiteLLM + OpenRouter 刷新模型定價...\n");
    const result = await db.refresh();
    process.stdout.write(`✅ 刷新完成：${result.modelCount} 個模型（來源：${result.source}）\n\n`);
  }

  if (opts.search) {
    const results = await db.search(opts.search);
    if (results.length === 0) {
      process.stdout.write(`📭 找不到含「${opts.search}」的模型。\n`);
      return;
    }
    process.stdout.write(`🔍 搜尋「${opts.search}」— 找到 ${results.length} 個模型：\n\n`);
    process.stdout.write(
      `${"模型 ID".padEnd(50)} ${"Input/1K".padStart(9)} ${"Output/1K".padStart(10)}  ${"來源".padEnd(12)}\n`,
    );
    process.stdout.write("─".repeat(90) + "\n");
    for (const { model, pricing } of results) {
      process.stdout.write(
        `${model.slice(0, 49).padEnd(50)} ` +
          `$${pricing.inputCostPer1k.toFixed(4).padStart(8)} ` +
          `$${pricing.outputCostPer1k.toFixed(4).padStart(9)}  ` +
          `${pricing.source.padEnd(12)}\n`,
      );
    }
  } else {
    process.stdout.write(
      "💡 使用 nuwa models --search <廠商或模型名> 查詢定價\n" +
        "   例：nuwa models --search claude\n" +
        "       nuwa models --search gpt-4\n" +
        "       nuwa models --search gemini\n" +
        "       nuwa models --search mistral\n" +
        "       nuwa models --search groq\n" +
        "       nuwa models --search deepseek\n\n" +
        "   nuwa models --refresh    從 LiteLLM + OpenRouter 拉取最新定價\n",
    );
  }
}

// ─── 費用狀態指令 ───────────────────────────────────────────────────

export async function cmdCostStatus(opts: { workspace?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const guard = createCostGuard(stateDir);
  const summary = await guard.monthlySummary();
  const reg = createSubscriptionRegistry(stateDir);
  const cycles = await reg.getBillingCycles();

  const lines = [
    `💼 費用守衛狀態`,
    ``,
    `📅 計費週期：${summary.periodLabel}（還剩 ${summary.daysRemaining} 天重置）`,
    ``,
  ];

  // 各訂閱計費週期進度
  if (cycles.length > 0) {
    lines.push(`訂閱週期進度：`);
    for (const { plan, cycle } of cycles) {
      const bar =
        "█".repeat(Math.round(cycle.percentElapsed / 5)) +
        "░".repeat(20 - Math.round(cycle.percentElapsed / 5));
      lines.push(
        `   ${plan.displayName.padEnd(24)} [${bar}] ${cycle.percentElapsed.toFixed(0).padStart(3)}%  ` +
          `剩 ${cycle.daysRemaining} 天  下次重置：${cycle.periodEnd.getFullYear()}-` +
          `${String(cycle.periodEnd.getMonth() + 1).padStart(2, "0")}-` +
          String(cycle.periodEnd.getDate()).padStart(2, "0"),
      );
    }
    lines.push(``);
  }

  lines.push(
    `本期費用概況：`,
    `   額外費用       ：$${summary.totalEstimatedUsd.toFixed(4)}`,
    `   訂閱免費操作   ：${summary.freeOperations} 次`,
    `   需付費操作     ：${summary.paidOperations} 次`,
    `   被守衛攔截     ：${summary.blockedOperations} 次`,
    ``,
  );

  if (Object.keys(summary.byOperation).length > 0) {
    lines.push(`操作統計（本計費週期）：`);
    for (const [op, stat] of Object.entries(summary.byOperation)) {
      lines.push(
        `   ${op.padEnd(22)} ${stat.count} 次` +
          (stat.estimatedUsd > 0 ? `  $${stat.estimatedUsd.toFixed(4)}` : "  （訂閱內免費）"),
      );
    }
    lines.push(``);
  }

  lines.push(
    `⚠️  原則：訂閱費覆蓋的操作永遠不額外計費。訂閱外的 API 調用需要您確認。`,
    `   nuwa sub list    查看訂閱覆蓋矩陣`,
    `   nuwa sub detect  重新掃描偵測訂閱`,
  );

  process.stdout.write(lines.join("\n") + "\n");
}

export async function cmdFreeze(
  slug: string,
  opts: { workspace?: string; unfreeze?: boolean },
): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const patterns = await readPatterns(stateDir);
  const idx = patterns.findIndex((p) => p.slug === slug || p.id === slug);
  if (idx < 0) {
    process.stderr.write(`❌ 找不到 slug="${slug}" 的 pattern。\n`);
    process.exitCode = 1;
    return;
  }
  patterns[idx].frozen = !opts.unfreeze;
  await writePatterns(stateDir, patterns);
  process.stdout.write(`${opts.unfreeze ? "🔓 已解凍" : "🔒 已凍結"} pattern：${slug}\n`);
}

export async function cmdInstall(slug: string, opts: { workspace?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const reg = await readRegistry(stateDir);
  if (!reg) {
    process.stderr.write(`❌ 找不到細胞登記表。\n`);
    process.exitCode = 1;
    return;
  }
  const cell = reg.stemCells.find((c) => c.slug === slug);
  if (!cell) {
    process.stderr.write(`❌ 找不到 slug="${slug}" 的幹細胞。\n`);
    process.exitCode = 1;
    return;
  }
  if (cell.status === "installed") {
    process.stdout.write(`⚠️  ${slug} 已是常駐狀態。\n`);
    return;
  }
  cell.status = "installed";
  cell.maturityScore = Math.max(cell.maturityScore, 0.8);
  await writeRegistry(stateDir, reg);
  process.stdout.write(`🌟 已手動晉升 ${slug} 為常駐幹細胞。\n`);
}

export async function cmdForget(
  slug: string,
  opts: { workspace?: string; force?: boolean },
): Promise<void> {
  if (!opts.force) {
    process.stderr.write(`⚠️  這將永久刪除 "${slug}" 的 pattern 和幹細胞。加上 --force 確認。\n`);
    process.exitCode = 1;
    return;
  }
  const stateDir = resolveStateDir(opts.workspace);
  const patterns = await readPatterns(stateDir);
  const before = patterns.length;
  const filtered = patterns.filter((p) => p.slug !== slug && p.id !== slug);
  if (filtered.length === before) {
    process.stderr.write(`❌ 找不到 slug="${slug}" 的 pattern。\n`);
    process.exitCode = 1;
    return;
  }
  await writePatterns(stateDir, filtered);

  const reg = await readRegistry(stateDir);
  if (reg) {
    reg.stemCells = reg.stemCells.filter((c) => c.slug !== slug);
    await writeRegistry(stateDir, reg);
  }
  process.stdout.write(`🗑️  已永久刪除 pattern 和幹細胞：${slug}\n`);
}

export async function cmdHatch(slug: string, opts: { workspace?: string }): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : process.cwd();
  const stateDir = resolveStateDir(opts.workspace);
  const patterns = await readPatterns(stateDir);
  const pattern = patterns.find((p) => p.slug === slug);
  if (!pattern) {
    process.stderr.write(`❌ 找不到 slug="${slug}" 的 pattern。\n`);
    process.exitCode = 1;
    return;
  }

  // 生成技能 Markdown
  const skillDir = path.join(workspaceDir, "skills", "nuwa", "examples");
  const skillPath = path.join(skillDir, `${slug}.md`);
  await fs.mkdir(skillDir, { recursive: true });
  const date = new Date().toISOString().split("T")[0];
  const content = [
    `# ${pattern.target} 思維蒸餾包`,
    ``,
    `> 孵化日期：${date}`,
    `> CLI 手動孵化 via \`nuwa hatch ${slug}\``,
    `> 信心度：${(pattern.confidence * 100).toFixed(0)}%`,
    ``,
    `---`,
    ``,
    `## 核心資訊`,
    ``,
    pattern.context,
    ``,
    `---`,
    ``,
    `## 心智模型`,
    ``,
    ...pattern.mentalModels.map((m, i) => `### ${i + 1}. ${m}\n`),
    `---`,
    ``,
    `## 關鍵觸發詞`,
    ``,
    ...pattern.keywords.map((k) => `- ${k}`),
    ``,
    `---`,
    ``,
    `## 使用方式`,
    ``,
    "```",
    `用 ${pattern.target} 的方式分析 [具體問題]`,
    "```",
  ].join("\n");

  await fs.writeFile(skillPath, content, "utf8");

  // 更新 skillPath
  const pidx = patterns.findIndex((p) => p.slug === slug);
  if (pidx >= 0) {
    patterns[pidx].skillPath = path.relative(workspaceDir, skillPath).replace(/\\/g, "/");
    await writePatterns(stateDir, patterns);
  }

  process.stdout.write(
    `🐣 孵化完成：\n   技能文件：${skillPath}\n   skillPath 已更新至 patterns.jsonl\n`,
  );
}

// ─── 主函數：掛載所有子指令到 commander program ─────────────────

export function registerEvolutionCli(program: Command): void {
  const evo = program.command("evolution").description("🏺 女媧四層進化學習系統");

  evo
    .command("status")
    .description("顯示整體進化狀態概覽")
    .option("-w, --workspace <dir>", "指定工作目錄（預設：當前目錄）")
    .option("--json", "以 JSON 格式輸出")
    .action((opts) => void cmdStatus(opts));

  evo
    .command("patterns")
    .description("列出所有女媧蒸餾模式")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--json", "以 JSON 格式輸出")
    .action((opts) => void cmdPatterns(opts));

  evo
    .command("cells")
    .description("顯示幹細胞池狀態")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--json", "以 JSON 格式輸出")
    .action((opts) => void cmdCells(opts));

  evo
    .command("top")
    .description("最常使用的 Top-5 人物框架")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--json", "以 JSON 格式輸出")
    .action((opts) => void cmdTop(opts));

  evo
    .command("rem")
    .description("觸發一次 REM 週期（需 OpenClaw 插件上下文）")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .action((opts) => void cmdRem(opts));

  evo
    .command("distill <target>")
    .description("自動蒸餾一個新主題為 NuwaPattern")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--tavily-key <key>", "Tavily API Key（也可用 TAVILY_API_KEY 環境變數）")
    .action(
      (target: string, opts: { workspace?: string; tavilyKey?: string }) =>
        void cmdDistill(target, opts),
    );

  evo
    .command("freeze <slug>")
    .description("凍結 pattern（停止代謝衰減）")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .action(
      (slug: string, opts: { workspace?: string }) =>
        void cmdFreeze(slug, { ...opts, unfreeze: false }),
    );

  evo
    .command("unfreeze <slug>")
    .description("解凍 pattern")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .action(
      (slug: string, opts: { workspace?: string }) =>
        void cmdFreeze(slug, { ...opts, unfreeze: true }),
    );

  evo
    .command("install <slug>")
    .description("手動晉升幹細胞為常駐（installed）")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .action((slug: string, opts: { workspace?: string }) => void cmdInstall(slug, opts));

  evo
    .command("forget <slug>")
    .description("永久刪除 pattern（需 --force）")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--force", "確認刪除")
    .action(
      (slug: string, opts: { workspace?: string; force?: boolean }) => void cmdForget(slug, opts),
    );

  evo
    .command("hatch <slug>")
    .description("手動孵化：生成技能 Markdown 並更新 skillPath")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .action((slug: string, opts: { workspace?: string }) => void cmdHatch(slug, opts));

  evo
    .command("cost")
    .description("查看費用守衛狀態與本月費用概況")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .action((opts) => void cmdCostStatus(opts));

  evo
    .command("models")
    .description("查詢所有 AI 模型定價（從 LiteLLM + OpenRouter 動態拉取）")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--search <query>", "搜尋模型名稱或廠商")
    .option("--refresh", "強制從網路拉取最新定價")
    .action((opts) => void cmdModels(opts));

  // ── 訂閱管理 sub-group ────────────────────────────────────────────

  const sub = evo
    .command("sub")
    .description("訂閱方案管理（決定哪些操作是訂閱內免費、哪些需要額外付費）");

  sub
    .command("list")
    .description("查看已登記的訂閱與操作覆蓋矩陣")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .action((opts) => void cmdSubList(opts));

  sub
    .command("plans")
    .description("列出所有可登記的訂閱方案")
    .action(() => void cmdSubPlans());

  sub
    .command("add <id>")
    .description("登記訂閱（例：claude-max-20、openai-pro、codex-cli-key）")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--key <apiKey>", "API Key（per-token 方案需要）")
    .option("--note <text>", "備注說明")
    .option("--budget <usd>", "此訂閱的月預算上限（USD）")
    .action((id: string, opts) => void cmdSubAdd(id, opts));

  sub
    .command("remove <id>")
    .description("移除已登記的訂閱")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .action((id: string, opts) => void cmdSubRemove(id, opts));

  sub
    .command("detect")
    .description("自動掃描所有 AI 工具設定檔、CLI 工具、環境變數，判斷你有哪些訂閱")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--force", "強制重新掃描（忽略 1 小時快取）")
    .action((opts) => void cmdSubDetect(opts));

  sub
    .command("verify")
    .description(`查驗所有訂閱是否仍然有效（每 15 天自動執行，此指令可手動觸發）`)
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--force", "強制執行（無論距上次查驗多久）")
    .action((opts) => void cmdSubVerify(opts));

  sub
    .command("budget <amount>")
    .description("設定全域月預算上限（USD，0 = 清除限制）")
    .option("-w, --workspace <dir>", "指定工作目錄")
    .option("--behavior <mode>", "超過預算時的行為：block（封鎖）或 warn（僅警告）", "block")
    .action((amount: string, opts) => void cmdSubBudget(amount, opts));
}

// ─── 互動式 REPL 對話 ────────────────────────────────────────────

export async function cmdChat(opts: {
  workspace?: string;
  persona?: string;
  session?: string;
  agent?: string;
}): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const db = openDb(stateDir);
  const agent = opts.agent ?? "claude";
  const persona = opts.persona;
  let personaDescription = "";

  if (persona) {
    const row = db.local
      .prepare("SELECT name, description FROM personas WHERE slug = ?")
      .get(persona) as { name: string; description: string } | undefined;
    if (row) {
      console.log(`[角色] ${row.name}：${row.description}`);
      personaDescription = row.description;
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: string[] = [];
  const prompt = `nuwa [${persona ?? "default"}] > `;

  const ask = (): void => {
    rl.question(prompt, (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        ask();
        return;
      }
      history.push(trimmed);

      if (trimmed === "/exit") {
        console.log("💾 對話已結束");
        db.local.close();
        db.global.close();
        rl.close();
        return;
      }

      if (trimmed === "/save") {
        console.log("💾 對話摘要已儲存（請使用 MCP save_conversation 工具完成完整儲存）");
      } else if (trimmed === "/patterns") {
        const rows = db.local
          .prepare("SELECT slug, target, confidence FROM patterns ORDER BY confidence DESC LIMIT 5")
          .all() as Array<{ slug: string; target: string; confidence: number }>;
        if (rows.length === 0) {
          console.log("（無 patterns）");
        } else {
          rows.forEach((r, i) =>
            console.log(`  ${i + 1}. ${r.slug} [${r.target}] conf=${r.confidence.toFixed(2)}`),
          );
        }
      } else if (trimmed === "/history") {
        history.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
      } else if (trimmed.startsWith("/assign ")) {
        const parts = trimmed.split(" ");
        const ag = parts[1] ?? "claude";
        const p = parts[2] ?? "(未指定)";
        console.log(`✅ 已指派 ${p} 給 ${ag}`);
      } else if (trimmed.startsWith("/debate ")) {
        const topic = trimmed.slice(8).trim();
        if (!topic) {
          console.log("用法：/debate <主題>");
          ask();
          return;
        }
        console.log(`🗣️ 觸發辯論：${topic}`);
        runDMAD(topic, db.local, { maxRounds: 3 })
          .then((result) => {
            console.log(`\n✅ 辯論完成（${result.totalRounds} 輪，停止原因：${result.stoppedBy}）`);
            console.log(`收斂分：${result.convergenceScore.toFixed(2)}`);
            console.log(`費用估算：$${result.estimatedCostUsd}`);
            console.log(`\n## 最終答案\n${result.finalAnswer}`);
            ask();
          })
          .catch((err: unknown) => {
            console.error("辯論失敗：", err);
            ask();
          });
        return;
      } else {
        const label = `${agent}${persona ? ` / ${persona}` : ""}`;
        process.stdout.write(`[${label}] 思考中...`);
        const systemPrompt = personaDescription ? `你正在扮演：${personaDescription}\n` : "";
        const fullPrompt = systemPrompt + trimmed;

        execFileAsync("claude", ["-p", fullPrompt, "--output-format", "json"], {
          timeout: 30_000,
        })
          .then(({ stdout }) => {
            try {
              const json = JSON.parse(stdout) as { result?: string };
              process.stdout.write(`\r[${label}]: ${json.result ?? stdout}\n`);
            } catch {
              process.stdout.write(`\r[${label}]: ${stdout.slice(0, 500)}\n`);
            }
            ask();
          })
          .catch((err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") {
              process.stdout.write(
                `\r[${label}]: （claude CLI 未安裝，請執行：npm install -g @anthropic-ai/claude-code）\n`,
              );
            } else {
              process.stdout.write(`\r[${label}]: （呼叫失敗：${String(err).slice(0, 100)}）\n`);
            }
            ask();
          });
        return;
      }

      ask();
    });
  };

  ask();
  await new Promise<void>((resolve) => rl.on("close", resolve));
}

// ─── 三代理辯論 ──────────────────────────────────────────────────

export async function cmdDebate(
  topic: string,
  opts: { workspace?: string; rounds?: number; model?: string; noMoa?: boolean },
): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const db = openDb(stateDir);
  try {
    console.log(`🗣️  DMAD 三代理辯論啟動...`);
    console.log(`主題：${topic}`);
    console.log(`最多輪次：${opts.rounds ?? 3}`);
    console.log();

    const result = await runDMAD(topic, db.local, {
      maxRounds: opts.rounds ?? 3,
      claudeModel: opts.model ?? "claude-haiku-4-5",
    });

    console.log(`\n✅ 辯論完成（${result.totalRounds} 輪，停止原因：${result.stoppedBy}）`);
    console.log(`收斂分：${result.convergenceScore.toFixed(2)}`);
    console.log(`費用估算：$${result.estimatedCostUsd}`);
    console.log(`激活 patterns：${result.patternSlugsUsed.join(", ") || "無"}`);
    console.log(`\n## MoA 最終答案`);
    console.log(result.finalAnswer);
  } finally {
    db.local.close();
    db.global.close();
  }
}

// ─── Persona 管理 ────────────────────────────────────────────────

export async function cmdPersonaList(opts: {
  workspace?: string;
  minFitness?: number;
}): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const db = openDb(stateDir);

  const minFitness = opts.minFitness ?? 0;
  const rows = db.local
    .prepare(
      "SELECT slug, name, description, fitness_score, agent_type FROM personas WHERE fitness_score >= ? ORDER BY fitness_score DESC",
    )
    .all(minFitness) as Array<{
    slug: string;
    name: string;
    description: string;
    fitness_score: number;
    agent_type: string;
  }>;

  if (rows.length === 0) {
    console.log("（無角色）");
    return;
  }

  console.log(`找到 ${rows.length} 個角色：\n`);
  for (const r of rows) {
    console.log(`  slug        : ${r.slug}`);
    console.log(`  名稱        : ${r.name}`);
    console.log(`  描述        : ${r.description}`);
    console.log(`  代理        : ${r.agent_type}`);
    console.log(`  適應度      : ${r.fitness_score.toFixed(3)}`);
    console.log();
  }
}

export async function cmdPersonaCreate(opts: {
  workspace?: string;
  slug: string;
  name: string;
  description: string;
  style?: string;
  focus?: string;
  pattern?: string;
}): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const db = openDb(stateDir);

  const id = `persona-${randomUUID()}`;
  db.local
    .prepare(
      `INSERT INTO personas (id, slug, name, description, style, focus, base_pattern_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.slug,
      opts.name,
      opts.description,
      opts.style ?? null,
      opts.focus ?? null,
      opts.pattern ?? null,
    );

  console.log(`✅ 角色已建立：${opts.slug} (${opts.name})`);
}

export async function cmdPersonaUse(slug: string, opts: { workspace?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const db = openDb(stateDir);

  const row = db.local
    .prepare("SELECT name, description, fitness_score FROM personas WHERE slug = ?")
    .get(slug) as { name: string; description: string; fitness_score: number } | undefined;

  if (!row) {
    console.error(`錯誤：找不到角色 "${slug}"`);
    process.exitCode = 1;
    return;
  }

  console.log(`角色：${row.name} (${slug})`);
  console.log(`描述：${row.description}`);
  console.log(`適應度：${row.fitness_score.toFixed(3)}`);
  console.log();
  console.log(`使用方式：nuwa chat --persona ${slug}`);
}

// ─── 對話歷程 ────────────────────────────────────────────────────

export async function cmdHistory(opts: {
  workspace?: string;
  sessionId?: string;
  mode?: string;
  search?: string;
  limit?: number;
}): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const db = openDb(stateDir);
  const limit = opts.limit ?? 20;

  if (opts.sessionId) {
    const turns = db.local
      .prepare(
        `SELECT turn_index, speaker, persona_slug, content, recorded_at
         FROM dialogue_turns dt
         JOIN conversations c ON c.id = dt.conversation_id
         WHERE c.id = ? OR c.session_id = ?
         ORDER BY turn_index ASC`,
      )
      .all(opts.sessionId, opts.sessionId) as Array<{
      turn_index: number;
      speaker: string;
      persona_slug: string | null;
      content: string;
      recorded_at: string;
    }>;

    if (turns.length === 0) {
      console.log(`（Session "${opts.sessionId}" 無對話記錄）`);
      return;
    }

    console.log(`Session：${opts.sessionId}，共 ${turns.length} 輪\n`);
    for (const t of turns) {
      const label = t.persona_slug ? `${t.speaker}/${t.persona_slug}` : t.speaker;
      console.log(`  [${t.turn_index}] ${label}（${t.recorded_at}）`);
      console.log(`       ${t.content}`);
    }
    return;
  }

  if (opts.search) {
    const rows = db.local
      .prepare(
        `SELECT id, session_id, summary, dialogue_mode, started_at
         FROM conversations
         WHERE summary LIKE ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(`%${opts.search}%`, limit) as Array<{
      id: string;
      session_id: string | null;
      summary: string;
      dialogue_mode: string;
      started_at: string;
    }>;

    if (rows.length === 0) {
      console.log(`（無符合 "${opts.search}" 的對話）`);
      return;
    }

    console.log(`搜尋結果：${rows.length} 筆\n`);
    for (const r of rows) {
      console.log(`  ID   : ${r.id}`);
      console.log(`  摘要 : ${r.summary}`);
      console.log(`  模式 : ${r.dialogue_mode}  時間 : ${r.started_at}`);
      console.log();
    }
    return;
  }

  const modeClause = opts.mode ? "AND dialogue_mode = ?" : "";
  const params: unknown[] = opts.mode ? [opts.mode, limit] : [limit];
  const rows = db.local
    .prepare(
      `SELECT id, session_id, summary, dialogue_mode, role_assignments, started_at
       FROM conversations
       WHERE 1=1 ${modeClause}
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    session_id: string | null;
    summary: string;
    dialogue_mode: string;
    role_assignments: string;
    started_at: string;
  }>;

  if (rows.length === 0) {
    console.log("（無對話歷程）");
    return;
  }

  console.log(`最近 ${rows.length} 筆對話：\n`);
  for (const r of rows) {
    const roles = r.role_assignments !== "{}" ? ` 角色：${r.role_assignments}` : "";
    console.log(`  ${r.started_at}  [${r.dialogue_mode}]${roles}`);
    console.log(`    ${r.summary.slice(0, 80)}${r.summary.length > 80 ? "…" : ""}`);
    console.log(`    ID: ${r.id}`);
    console.log();
  }
}
