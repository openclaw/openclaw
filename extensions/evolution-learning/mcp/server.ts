/**
 * nuwa MCP Server — Streamable HTTP
 *
 * 使用 Hono + @modelcontextprotocol/sdk WebStandardStreamableHTTPServerTransport
 * 讓 Claude Code CLI / 任何 MCP 客戶端 都能使用 nuwa 進化學習工具。
 *
 * 啟動：
 *   MCP_PORT=34821 npx tsx mcp/server.ts
 *
 * 在 claude_desktop_config.json 或 Claude Code settings.json 中設定：
 *   {
 *     "mcpServers": {
 *       "nuwa": {
 *         "type": "http",
 *         "url": "http://localhost:34821/mcp"
 *       }
 *     }
 *   }
 *
 * 多客戶端（OpenClaw + Claude CLI）可同時連接，共享同一份 nuwa 狀態。
 *
 * 費用模型：
 *   - MCP Server 本身是純 Node.js 進程，零 API 費用
 *   - distill --tavily 操作會先通過費用守衛確認
 *   - 所有其他操作（status/patterns/cells/freeze/hatch）= 零成本
 *
 * 資料儲存：SQLite WAL（nuwa.db），啟動時自動遷移舊 JSON/JSONL 格式。
 */

import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { hermesUpdateConstitution, learnEffectivePrinciple } from "../src/constitutional.js";
import { createCostGuard } from "../src/cost-guard.js";
import { startCroner } from "../src/croner.js";
import { openDb } from "../src/db.js";
import { runDMAD } from "../src/dmad-debate.js";
import { runGoT } from "../src/got-reasoning.js";
import { createHermesGate, classifyRisk as hermesClassifyRisk } from "../src/hermes-gate.js";
import { migrateIfNeeded } from "../src/migrate.js";
import { runEvolutionCycle } from "../src/role-evolution.js";
import { createSubscriptionRegistry } from "../src/subscription-registry.js";

// ─── 型別 ───────────────────────────────────────────────────────────

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
  skillPath?: string | null;
  frozen?: boolean;
  lastUsed?: string | null;
  createdAt: string;
  parentSlug?: string | null;
  scope?: "local" | "global" | "shared";
  decayScore?: number;
  lastActivated?: string | null;
};

type StemCell = {
  id: string;
  slug: string;
  target: string;
  status: "embryo" | "incubating" | "ready" | "installed";
  maturityScore: number;
  usageCount: number;
  positiveRating: number;
  lastEvaluated?: string | null;
};

// SQLite 原始列型別（snake_case）
type PatternRow = {
  id: string;
  slug: string;
  target: string;
  confidence: number;
  success_rate: number;
  sample_count: number;
  mental_models: string;
  keywords: string;
  context: string;
  skill_path: string | null;
  frozen: number;
  last_used: string | null;
  created_at: string;
  updated_at: string;
  parent_slug: string | null;
  scope: string;
  decay_score: number;
  last_activated: string | null;
};

type StemCellRow = {
  id: string;
  slug: string;
  target: string;
  status: string;
  maturity_score: number;
  usage_count: number;
  positive_rating: number;
  last_evaluated: string | null;
};

// ─── 列轉換（snake_case → camelCase）───────────────────────────────

function rowToPattern(row: PatternRow): NuwaPattern {
  return {
    id: row.id,
    slug: row.slug,
    target: row.target,
    confidence: row.confidence,
    successRate: row.success_rate,
    sampleCount: row.sample_count,
    mentalModels: JSON.parse(row.mental_models) as string[],
    keywords: JSON.parse(row.keywords) as string[],
    context: row.context,
    skillPath: row.skill_path,
    frozen: row.frozen === 1,
    lastUsed: row.last_used,
    createdAt: row.created_at,
    parentSlug: row.parent_slug,
    scope: row.scope as "local" | "global" | "shared",
    decayScore: row.decay_score,
    lastActivated: row.last_activated,
  };
}

function rowToCell(row: StemCellRow): StemCell {
  return {
    id: row.id,
    slug: row.slug,
    target: row.target,
    status: row.status as StemCell["status"],
    maturityScore: row.maturity_score,
    usageCount: row.usage_count,
    positiveRating: row.positive_rating,
    lastEvaluated: row.last_evaluated,
  };
}

// ─── 工具函數 ───────────────────────────────────────────────────────

function resolveStateDir(workspaceDir?: string): string {
  const base = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
  return path.join(base, ".claude", "evolution-state");
}

// ─── SQLite 讀寫層 ──────────────────────────────────────────────────

function readPatterns(db: Database.Database, filter?: string, limit = 1000): NuwaPattern[] {
  if (filter) {
    const f = `%${filter.toLowerCase()}%`;
    return (
      db
        .prepare(
          `SELECT * FROM patterns WHERE lower(slug) LIKE ? OR lower(target) LIKE ?
           ORDER BY sample_count DESC LIMIT ?`,
        )
        .all(f, f, limit) as PatternRow[]
    ).map(rowToPattern);
  }
  return (
    db
      .prepare(`SELECT * FROM patterns ORDER BY sample_count DESC LIMIT ?`)
      .all(limit) as PatternRow[]
  ).map(rowToPattern);
}

function readCells(db: Database.Database, statusFilter?: string): StemCell[] {
  if (statusFilter && statusFilter !== "all") {
    return (
      db.prepare(`SELECT * FROM stem_cells WHERE status = ?`).all(statusFilter) as StemCellRow[]
    ).map(rowToCell);
  }
  return (db.prepare(`SELECT * FROM stem_cells`).all() as StemCellRow[]).map(rowToCell);
}

function upsertPattern(db: Database.Database, p: NuwaPattern): void {
  db.prepare(`
    INSERT INTO patterns (
      id, slug, target, confidence, success_rate, sample_count,
      mental_models, keywords, context, skill_path, frozen,
      last_used, created_at, updated_at,
      parent_slug, scope, decay_score, last_activated
    ) VALUES (
      @id, @slug, @target, @confidence, @successRate, @sampleCount,
      @mentalModels, @keywords, @context, @skillPath, @frozen,
      @lastUsed, @createdAt, @updatedAt,
      @parentSlug, @scope, @decayScore, @lastActivated
    )
    ON CONFLICT(slug) DO UPDATE SET
      target       = excluded.target,
      confidence   = excluded.confidence,
      success_rate = excluded.success_rate,
      sample_count = excluded.sample_count,
      mental_models = excluded.mental_models,
      keywords     = excluded.keywords,
      context      = excluded.context,
      skill_path   = excluded.skill_path,
      frozen       = excluded.frozen,
      last_used    = excluded.last_used,
      updated_at   = excluded.updated_at,
      parent_slug  = excluded.parent_slug,
      scope        = excluded.scope,
      decay_score  = excluded.decay_score,
      last_activated = excluded.last_activated
  `).run({
    id: p.id,
    slug: p.slug,
    target: p.target,
    confidence: p.confidence,
    successRate: p.successRate,
    sampleCount: p.sampleCount,
    mentalModels: JSON.stringify(p.mentalModels),
    keywords: JSON.stringify(p.keywords),
    context: p.context,
    skillPath: p.skillPath ?? null,
    frozen: p.frozen ? 1 : 0,
    lastUsed: p.lastUsed ?? null,
    createdAt: p.createdAt,
    updatedAt: new Date().toISOString(),
    parentSlug: p.parentSlug ?? null,
    scope: p.scope ?? "local",
    decayScore: p.decayScore ?? 1.0,
    lastActivated: p.lastActivated ?? null,
  });
}

// ─── MCP Server 工廠（每 request 建一個，stateless）────────────────

function createNuwaMcpServer(stateDir: string, db: Database.Database): McpServer {
  const server = new McpServer({
    name: "nuwa-evolution-learning",
    version: "2026.5.5",
  });

  const guard = createCostGuard(stateDir);

  // ── 工具 1：nuwa_status ───────────────────────────────────────────
  server.registerTool(
    "nuwa_status",
    {
      title: "女媧進化狀態",
      description: "顯示 nuwa 四層進化系統整體狀態（pattern 數量、幹細胞池分佈）。零成本操作。",
      inputSchema: {
        workspace: z.string().optional().describe("工作目錄（預設：當前目錄）"),
      },
    },
    async ({ workspace: _workspace }) => {
      const patterns = readPatterns(db);
      const cells = readCells(db);

      const status = {
        stateDir,
        patterns: patterns.length,
        frozenPatterns: patterns.filter((p) => p.frozen).length,
        cells: {
          installed: cells.filter((c) => c.status === "installed").length,
          ready: cells.filter((c) => c.status === "ready").length,
          incubating: cells.filter((c) => c.status === "incubating").length,
          embryo: cells.filter((c) => c.status === "embryo").length,
        },
        billing: await guard.getBillingInfo(),
        topPatterns: patterns
          .slice(0, 5)
          .map((p) => ({ target: p.target, slug: p.slug, sampleCount: p.sampleCount })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "🏺 女媧四層進化系統狀態",
              "",
              `📚 學習模式庫：${status.patterns} 個 pattern（${status.frozenPatterns} 個凍結）`,
              `🧬 有機細胞池：🌟 ${status.cells.installed} 常駐 / ✅ ${status.cells.ready} 就緒 / 🐣 ${status.cells.incubating} 孵化 / 🥚 ${status.cells.embryo} 胚胎`,
              "",
              `📊 Top 5 模式：`,
              ...status.topPatterns.map(
                (p, i) => `  ${i + 1}. ${p.target}（${p.sampleCount} 次使用）`,
              ),
              "",
              `💼 ${status.billing}`,
              `📁 狀態目錄：${stateDir}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 工具 2：nuwa_patterns ─────────────────────────────────────────
  server.registerTool(
    "nuwa_patterns",
    {
      title: "列出女媧模式",
      description: "列出所有已蒸餾的 NuwaPattern，可按 slug/target 篩選。零成本操作。",
      inputSchema: {
        workspace: z.string().optional(),
        filter: z.string().optional().describe("篩選關鍵字（slug 或 target 含此字串）"),
        limit: z.number().optional().describe("最大回傳數量（預設 20）"),
      },
    },
    async ({ filter, limit = 20 }) => {
      const patterns = readPatterns(db, filter, limit);
      const total = (db.prepare("SELECT COUNT(*) as cnt FROM patterns").get() as { cnt: number })
        .cnt;

      return {
        content: [
          {
            type: "text" as const,
            text:
              patterns.length === 0
                ? "📭 找不到符合條件的 pattern。"
                : [
                    `🧠 女媧模式（${patterns.length}/${total} 個）：`,
                    "",
                    ...patterns.map(
                      (p) =>
                        `• ${p.target.padEnd(16)} ` +
                        `信心 ${(p.confidence * 100).toFixed(0).padStart(3)}%  ` +
                        `使用 ${String(p.sampleCount).padStart(4)} 次  ` +
                        `slug: ${p.slug}` +
                        (p.frozen ? "  🔒" : "") +
                        (p.skillPath ? "  📄" : "") +
                        (p.parentSlug ? `  ↑${p.parentSlug}` : ""),
                    ),
                  ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 工具 3：nuwa_cells ───────────────────────────────────────────
  server.registerTool(
    "nuwa_cells",
    {
      title: "幹細胞池狀態",
      description: "顯示有機幹細胞池（胚胎→孵化→就緒→常駐）的詳細狀態。零成本操作。",
      inputSchema: {
        workspace: z.string().optional(),
        status: z
          .enum(["embryo", "incubating", "ready", "installed", "all"])
          .optional()
          .describe("篩選狀態（預設 all）"),
      },
    },
    async ({ status = "all" }) => {
      const cells = readCells(db, status);

      const icon = (s: string) =>
        (
          ({ embryo: "🥚", incubating: "🐣", ready: "✅", installed: "🌟" }) as Record<
            string,
            string
          >
        )[s] ?? "❓";

      return {
        content: [
          {
            type: "text" as const,
            text:
              cells.length === 0
                ? "📭 幹細胞池為空。"
                : [
                    `🧬 幹細胞池（${cells.length} 個）：`,
                    "",
                    ...cells.map(
                      (c) =>
                        `${icon(c.status)} ${c.target.padEnd(16)} ` +
                        `成熟度 ${(c.maturityScore * 100).toFixed(0).padStart(3)}%  ` +
                        `使用 ${String(c.usageCount).padStart(3)} 次  ` +
                        `評分 ${(c.positiveRating * 100).toFixed(0)}%  ` +
                        `slug: ${c.slug}`,
                    ),
                  ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 工具 4：nuwa_distill ─────────────────────────────────────────
  server.registerTool(
    "nuwa_distill",
    {
      title: "蒸餾新主題",
      description:
        "將新主題蒸餾為 NuwaPattern。可選 Tavily 搜尋加強（免費額度 1000 次/月）。" +
        "費用守衛會自動確認是否在預算內。",
      inputSchema: {
        target: z.string().describe("要蒸餾的主題（人物、思維框架等）"),
        workspace: z.string().optional(),
        tavilyKey: z
          .string()
          .optional()
          .describe("Tavily API Key（也可設 TAVILY_API_KEY 環境變數）"),
        keywords: z.array(z.string()).optional().describe("手動指定關鍵字（不使用 Tavily 時）"),
        mentalModels: z.array(z.string()).optional().describe("手動指定心智模型"),
        parentSlug: z
          .string()
          .optional()
          .describe("父 pattern slug（繼承其心智模型與 Prompt 權重）"),
      },
    },
    async ({ target, tavilyKey, keywords: manualKeywords, mentalModels: manualMM, parentSlug }) => {
      // 費用守衛：Tavily 搜尋
      const apiKey = tavilyKey ?? process.env.TAVILY_API_KEY;
      if (apiKey) {
        const ok = await guard.gate("tavily_search", { callCount: 1 });
        if (!ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `🚫 費用守衛攔截了 Tavily 搜尋。請確認後重試，或不傳入 tavilyKey 改用啟發式蒸餾。`,
              },
            ],
          };
        }
      }

      const slug = target
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");

      let keywords: string[] = manualKeywords ?? [target, slug];
      let mentalModels: string[] = manualMM ?? [`${target} 思維框架`, `${target} 核心原則`];
      let confidence = 0.45;

      // 繼承父 pattern 的心智模型
      if (parentSlug) {
        const parentRow = db
          .prepare(`SELECT mental_models, keywords FROM patterns WHERE slug = ?`)
          .get(parentSlug) as { mental_models: string; keywords: string } | undefined;
        if (parentRow) {
          const parentMM = JSON.parse(parentRow.mental_models) as string[];
          mentalModels = [...new Set([...mentalModels, ...parentMM])];
          confidence = Math.min(confidence + 0.1, 0.9); // 繼承提升信心度
        }
      }

      if (apiKey) {
        try {
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
            confidence = Math.min(confidence + 0.1, 0.9);
          }
        } catch {
          /* fallback，使用啟發式 */
        }
      }

      const pattern: NuwaPattern = {
        id: `${slug}-mcp-v${Date.now()}`,
        slug,
        target,
        confidence,
        successRate: 0.5,
        sampleCount: 0,
        mentalModels,
        keywords,
        context: `${target} — 由 nuwa MCP server 蒸餾（${new Date().toISOString().split("T")[0]}）`,
        skillPath: null,
        frozen: false,
        createdAt: new Date().toISOString(),
        lastUsed: null,
        parentSlug: parentSlug ?? null,
        scope: "local",
        decayScore: 1.0,
        lastActivated: null,
      };

      upsertPattern(db, pattern);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `🧬 蒸餾完成（已寫入 SQLite）：`,
              `   target    ：${target}`,
              `   slug      ：${slug}`,
              `   信心度    ：${(confidence * 100).toFixed(0)}%`,
              `   關鍵字    ：${keywords.slice(0, 5).join("、")}...`,
              `   心智模型  ：${mentalModels.join("、")}`,
              ...(parentSlug ? [`   繼承自    ：${parentSlug}`] : []),
              `   scope     ：local`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 工具 5：nuwa_freeze ──────────────────────────────────────────
  server.registerTool(
    "nuwa_freeze",
    {
      title: "凍結/解凍 Pattern",
      description: "凍結 pattern 以停止 REM 代謝衰減，或解凍恢復正常代謝。零成本操作。",
      inputSchema: {
        slug: z.string().describe("要凍結的 pattern slug"),
        workspace: z.string().optional(),
        unfreeze: z.boolean().optional().describe("true = 解凍（預設 false = 凍結）"),
      },
    },
    async ({ slug, unfreeze = false }) => {
      const existing = db
        .prepare(`SELECT * FROM patterns WHERE slug = ? OR id = ?`)
        .get(slug, slug) as PatternRow | undefined;

      if (!existing) {
        return {
          content: [{ type: "text" as const, text: `❌ 找不到 slug="${slug}" 的 pattern。` }],
        };
      }

      db.prepare(`UPDATE patterns SET frozen = ?, updated_at = ? WHERE slug = ?`).run(
        unfreeze ? 0 : 1,
        new Date().toISOString(),
        existing.slug,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${unfreeze ? "🔓 已解凍" : "🔒 已凍結"} pattern：${existing.slug}`,
          },
        ],
      };
    },
  );

  // ── 工具 6：nuwa_hatch ───────────────────────────────────────────
  server.registerTool(
    "nuwa_hatch",
    {
      title: "孵化技能文件",
      description: "為指定 pattern 生成技能 Markdown 並更新 skillPath。零成本操作。",
      inputSchema: {
        slug: z.string().describe("要孵化的 pattern slug"),
        workspace: z.string().optional(),
      },
    },
    async ({ slug, workspace }) => {
      const workspaceDir = workspace ? path.resolve(workspace) : process.cwd();

      const row = db.prepare(`SELECT * FROM patterns WHERE slug = ?`).get(slug) as
        | PatternRow
        | undefined;

      if (!row) {
        return {
          content: [{ type: "text" as const, text: `❌ 找不到 slug="${slug}" 的 pattern。` }],
        };
      }

      const pattern = rowToPattern(row);
      const skillDir = path.join(workspaceDir, "skills", "nuwa", "examples");
      const skillPath = path.join(skillDir, `${slug}.md`);
      await fs.mkdir(skillDir, { recursive: true });

      const date = new Date().toISOString().split("T")[0];
      const content = [
        `# ${pattern.target} 思維蒸餾包`,
        ``,
        `> 孵化日期：${date}`,
        `> MCP Server 自動孵化`,
        `> 信心度：${(pattern.confidence * 100).toFixed(0)}%`,
        ...(pattern.parentSlug ? [`> 繼承自：${pattern.parentSlug}`] : []),
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

      const relPath = path.relative(workspaceDir, skillPath).replace(/\\/g, "/");
      db.prepare(`UPDATE patterns SET skill_path = ?, updated_at = ? WHERE slug = ?`).run(
        relPath,
        new Date().toISOString(),
        slug,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `🐣 孵化完成：`,
              `   技能文件：${skillPath}`,
              `   skillPath 已更新至 SQLite`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 工具 7：nuwa_cost_status ─────────────────────────────────────
  server.registerTool(
    "nuwa_cost_status",
    {
      title: "費用守衛與訂閱狀態",
      description: "查看本月費用概況與訂閱覆蓋矩陣。已登記的訂閱覆蓋的操作不額外收費。",
      inputSchema: {
        workspace: z.string().optional(),
      },
    },
    async ({ workspace }) => {
      const dir = resolveStateDir(workspace);
      const g = createCostGuard(dir);
      const reg = createSubscriptionRegistry(dir);
      const summary = await g.monthlySummary();
      const subSummary = await reg.summary();

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `💼 費用守衛狀態（${summary.periodLabel}）`,
              ``,
              `本月概況：`,
              `   估算額外費用   ：$${summary.totalEstimatedUsd.toFixed(4)}`,
              `   訂閱免費操作   ：${summary.freeOperations} 次`,
              `   需付費操作     ：${summary.paidOperations} 次`,
              `   被守衛攔截     ：${summary.blockedOperations} 次`,
              ``,
              subSummary,
              ``,
              `⚠️  原則：訂閱費已覆蓋的操作永遠免費；訂閱外的 API 調用需要確認。`,
              `   執行 nuwa sub add <id> 登記訂閱，讓更多操作自動放行。`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 工具 8：nuwa_sub_list ────────────────────────────────────────
  server.registerTool(
    "nuwa_sub_list",
    {
      title: "查看訂閱覆蓋矩陣",
      description: "顯示已登記的訂閱方案與每個操作的費用覆蓋狀況。",
      inputSchema: {
        workspace: z.string().optional(),
      },
    },
    async ({ workspace }) => {
      const dir = resolveStateDir(workspace);
      const reg = createSubscriptionRegistry(dir);
      return {
        content: [{ type: "text" as const, text: await reg.summary() }],
      };
    },
  );

  // ── 工具 9：create_persona ──────────────────────────────────────────
  server.registerTool(
    "create_persona",
    {
      title: "建立角色",
      description: "在 personas 表新增一個角色定義，可繼承 nuwa pattern 的心智模型框架。",
      inputSchema: {
        slug: z.string().describe("角色唯一識別（例：strict-cto）"),
        name: z.string().describe("角色顯示名稱（例：嚴格 CTO）"),
        description: z.string().describe("角色描述，會注入到 system prompt"),
        style: z.string().optional().describe("風格（嚴格/創意/務實/保守）"),
        focus: z.string().optional().describe("關注點（技術/商業/使用者體驗）"),
        basePatternSlug: z.string().optional().describe("繼承的 nuwa pattern slug"),
        agentType: z
          .enum(["claude", "codex", "openclaw"])
          .optional()
          .describe("預設由哪個代理扮演"),
      },
    },
    async ({ slug, name, description, style, focus, basePatternSlug, agentType = "claude" }) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      try {
        db.prepare(`
          INSERT INTO personas (id, slug, name, description, style, focus, base_pattern_slug, agent_type, fitness_score, created_at, updated_at)
          VALUES (@id, @slug, @name, @description, @style, @focus, @basePatternSlug, @agentType, 0.5, @now, @now)
        `).run({
          id,
          slug,
          name,
          description,
          style: style ?? null,
          focus: focus ?? null,
          basePatternSlug: basePatternSlug ?? null,
          agentType,
          now,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ 角色已建立：${name}（${slug}）\n繼承 pattern：${basePatternSlug ?? "無"}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ 建立失敗：${String(err)}` }] };
      }
    },
  );

  // ── 工具 10：list_personas ──────────────────────────────────────────
  server.registerTool(
    "list_personas",
    {
      title: "列出所有角色",
      description: "列出 personas 表中所有可用角色，含 fitness_score 與使用統計。",
      inputSchema: {
        minFitness: z.number().optional().describe("最低適應度篩選（0-1，預設不篩選）"),
        agentType: z.enum(["claude", "codex", "openclaw"]).optional().describe("按代理類型篩選"),
      },
    },
    async ({ minFitness, agentType }) => {
      // 使用參數化查詢防止 SQL injection
      const conditions: string[] = [];
      const params: (number | string)[] = [];
      if (minFitness !== undefined) {
        conditions.push("fitness_score >= ?");
        params.push(minFitness);
      }
      if (agentType) {
        conditions.push("agent_type = ?");
        params.push(agentType);
      }
      const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
      const sql = `SELECT slug, name, style, focus, agent_type, fitness_score, base_pattern_slug FROM personas${where} ORDER BY fitness_score DESC`;
      const rows = db.prepare(sql).all(...params) as Array<{
        slug: string;
        name: string;
        style: string | null;
        focus: string | null;
        agent_type: string;
        fitness_score: number;
        base_pattern_slug: string | null;
      }>;

      const text =
        rows.length === 0
          ? "📭 尚無任何角色。使用 create_persona 建立第一個角色。"
          : [
              `🎭 角色庫（${rows.length} 個）：`,
              "",
              ...rows.map(
                (r) =>
                  `• ${r.name.padEnd(12)} [${r.agent_type}]  ` +
                  `適應度 ${(r.fitness_score * 100).toFixed(0).padStart(3)}%  ` +
                  `風格：${r.style ?? "—"}  ` +
                  `關注：${r.focus ?? "—"}  ` +
                  `slug: ${r.slug}` +
                  (r.base_pattern_slug ? `  ↑${r.base_pattern_slug}` : ""),
              ),
            ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 11：assign_role ────────────────────────────────────────────
  server.registerTool(
    "assign_role",
    {
      title: "指派角色給代理",
      description: "在對話中將某個 persona 指派給指定代理，記錄到 dialogue_turns 表。",
      inputSchema: {
        conversationId: z.string().describe("對話 ID"),
        speaker: z.enum(["claude", "codex", "openclaw", "user"]).describe("代理識別"),
        personaSlug: z.string().describe("要指派的角色 slug"),
        content: z.string().optional().describe("該輪對話內容（可選）"),
        tokensUsed: z.number().optional(),
      },
    },
    async ({ conversationId, speaker, personaSlug, content = "", tokensUsed }) => {
      const persona = db.prepare("SELECT * FROM personas WHERE slug = ?").get(personaSlug) as
        | { name: string; description: string }
        | undefined;
      if (!persona) {
        return { content: [{ type: "text" as const, text: `❌ 找不到角色：${personaSlug}` }] };
      }

      const turnCount = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM dialogue_turns WHERE conversation_id = ?")
          .get(conversationId) as { cnt: number }
      ).cnt;
      db.prepare(`
        INSERT INTO dialogue_turns (id, conversation_id, turn_index, speaker, persona_slug, content, role_context, tokens_used, recorded_at)
        VALUES (@id, @conversationId, @turnIndex, @speaker, @personaSlug, @content, @roleContext, @tokensUsed, @now)
      `).run({
        id: crypto.randomUUID(),
        conversationId,
        turnIndex: turnCount,
        speaker,
        personaSlug,
        content,
        roleContext: persona.description,
        tokensUsed: tokensUsed ?? null,
        now: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `✅ 已將角色「${persona.name}」指派給 ${speaker}（對話 ${conversationId}，第 ${turnCount} 輪）`,
          },
        ],
      };
    },
  );

  // ── 工具 12：get_dialogue ───────────────────────────────────────────
  server.registerTool(
    "get_dialogue",
    {
      title: "取得對話歷程",
      description:
        "取得某對話的完整角色對話歷程（dialogue_turns 表），含每輪 speaker、persona、content。",
      inputSchema: {
        conversationId: z.string().describe("對話 ID"),
        limit: z.number().optional().describe("最多回傳輪數（預設 50）"),
      },
    },
    async ({ conversationId, limit = 50 }) => {
      const turns = db
        .prepare(`
        SELECT dt.*, p.name as persona_name FROM dialogue_turns dt
        LEFT JOIN personas p ON dt.persona_slug = p.slug
        WHERE dt.conversation_id = ?
        ORDER BY dt.turn_index ASC LIMIT ?
      `)
        .all(conversationId, limit) as Array<{
        turn_index: number;
        speaker: string;
        persona_name: string | null;
        persona_slug: string | null;
        content: string;
        tokens_used: number | null;
        recorded_at: string;
      }>;

      if (turns.length === 0) {
        return {
          content: [{ type: "text" as const, text: `📭 找不到對話 ${conversationId} 的記錄。` }],
        };
      }

      const text = [
        `💬 對話歷程（${conversationId}，${turns.length} 輪）：`,
        "",
        ...turns.map(
          (t) =>
            `[${t.turn_index}] ${t.speaker}${t.persona_name ? ` [${t.persona_name}]` : ""}：${t.content.slice(0, 120)}${t.content.length > 120 ? "…" : ""}`,
        ),
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 13：get_constitution ───────────────────────────────────────
  server.registerTool(
    "get_constitution",
    {
      title: "查詢憲法原則庫",
      description: "查詢某任務類型的憲法原則（依有效性 weight 降序）。",
      inputSchema: {
        taskType: z
          .enum([
            "architecture",
            "security",
            "cost_optimization",
            "code_quality",
            "agent_design",
            "general",
          ])
          .describe("任務類型"),
      },
    },
    async ({ taskType }) => {
      // 先同步 causal_edges 的學習結果回 constitution_principles.weight
      hermesUpdateConstitution(taskType, db);
      const rows = db
        .prepare(
          "SELECT principle, weight, win_count FROM constitution_principles WHERE task_type = ? ORDER BY weight DESC",
        )
        .all(taskType) as Array<{ principle: string; weight: number; win_count: number }>;

      const text =
        rows.length === 0
          ? `📭 尚無 ${taskType} 類型的憲法原則。`
          : [
              `⚖️ 憲法原則（${taskType}，${rows.length} 條）：`,
              "",
              ...rows.map(
                (r, i) =>
                  `${i + 1}. [weight ${r.weight.toFixed(2)} / 採納 ${r.win_count} 次] ${r.principle}`,
              ),
            ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 14：update_constitution ────────────────────────────────────
  server.registerTool(
    "update_constitution",
    {
      title: "新增 / 調整憲法原則",
      description: "新增憲法原則到指定任務類型，或標記某條原則是否有效（影響 weight）。",
      inputSchema: {
        taskType: z.enum([
          "architecture",
          "security",
          "cost_optimization",
          "code_quality",
          "agent_design",
          "general",
        ]),
        principle: z.string().describe("原則內容"),
        action: z.enum(["add", "mark_effective", "mark_ineffective"]).describe("操作類型"),
        initialWeight: z.number().optional().describe("新增時的初始 weight（預設 1.0）"),
      },
    },
    async ({ taskType, principle, action, initialWeight = 1.0 }) => {
      if (action === "add") {
        db.prepare(`
          INSERT OR IGNORE INTO constitution_principles (id, task_type, principle, weight, win_count, created_at, updated_at)
          VALUES (@id, @taskType, @principle, @weight, 0, @now, @now)
        `).run({
          id: crypto.randomUUID(),
          taskType,
          principle,
          weight: initialWeight,
          now: new Date().toISOString(),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ 原則已新增：「${principle}」（${taskType}，weight=${initialWeight}）`,
            },
          ],
        };
      }
      learnEffectivePrinciple(taskType, principle, action === "mark_effective", db);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ 已標記原則「${principle}」為${action === "mark_effective" ? "有效 ↑" : "無效 ↓"}`,
          },
        ],
      };
    },
  );

  // ── 工具 15：run_got_reasoning ──────────────────────────────────────
  server.registerTool(
    "run_got_reasoning",
    {
      title: "GoT 圖思維推理",
      description:
        "將任務拆解為 DAG 思維圖，透過 Hermes 因果圖選擇走訪策略，組裝各節點的推理 prompt 供 Claude Haiku 執行。",
      inputSchema: {
        task: z.string().describe("要推理的任務描述"),
        taskType: z.enum([
          "architecture",
          "security",
          "cost_optimization",
          "code_quality",
          "agent_design",
          "general",
        ]),
        maxNodes: z.number().optional().describe("最大節點數（預設 8）"),
        budgetUsd: z.number().optional().describe("費用上限（預設 $0.5）"),
      },
    },
    async ({ task, taskType, maxNodes = 8, budgetUsd = 0.5 }) => {
      const result = await runGoT(task, taskType, db, { maxNodes, budgetUsd });
      const text = [
        `🕸️ GoT 推理完成（策略：${result.strategy}${result.wasColdStart ? "，冷啟動" : ""}）`,
        `   節點數：${result.merged.length}  品質分：${(result.qualityScore * 100).toFixed(0)}%`,
        "",
        `📋 節點 prompts（共 ${result.merged.length} 個，請依序呼叫 Claude Haiku）：`,
        "",
        ...result.merged.map((n, i) => `--- 節點 ${i + 1}（${n.nodeType}）---\n${n.content}`),
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 16：evaluate_persona_fitness ──────────────────────────────
  server.registerTool(
    "evaluate_persona_fitness",
    {
      title: "評估角色適應度（EvoAgentX）",
      description:
        "讀取 Hermes learning-state.json，更新所有角色的 fitness_score，並執行演化週期（crossover + 多樣性選汰）。",
      inputSchema: {
        learningStatePath: z
          .string()
          .optional()
          .describe("learning-state.json 路徑（預設自動推算）"),
      },
    },
    async ({ learningStatePath }) => {
      const lsPath =
        learningStatePath ??
        path.join(
          process.env.NUWA_WORKSPACE ?? process.cwd(),
          "reports/hermes-agent/state/learning-state.json",
        );
      const result = await runEvolutionCycle(db, lsPath);

      const text = result.skipped
        ? "⏭️ 演化跳過：personas < 3，請先建立至少 3 個角色或等待 seed-personas.jsonl 載入。"
        : [
            `🧬 EvoAgentX 演化完成：`,
            `   評估角色數：${result.evaluated}`,
            `   新演化角色：${result.evolved}`,
            `   低分加速衰減：${result.pruned}`,
          ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 17：get_judge_history ──────────────────────────────────────
  server.registerTool(
    "get_judge_history",
    {
      title: "查詢 Judge 決策歷程",
      description:
        "從 causal_edges 表查詢 Hermes Judge（MAR）的歷史決策記錄（信心分、是否重試、採納了哪些批評）。",
      inputSchema: {
        limit: z.number().optional().describe("最多回傳筆數（預設 20）"),
        onlyLowConfidence: z.boolean().optional().describe("只看低信心（< 0.7）的決策"),
      },
    },
    async ({ limit = 20, onlyLowConfidence = false }) => {
      const sql = onlyLowConfidence
        ? `SELECT * FROM causal_edges WHERE relation = 'mar_judge' AND weight < 0.7 ORDER BY recorded_at DESC LIMIT ?`
        : `SELECT * FROM causal_edges WHERE relation = 'mar_judge' ORDER BY recorded_at DESC LIMIT ?`;

      const rows = db.prepare(sql).all(limit) as Array<{
        from_slug: string;
        to_slug: string;
        weight: number;
        recorded_at: string;
      }>;

      const text =
        rows.length === 0
          ? "📭 尚無 Judge 決策記錄。"
          : [
              `⚖️ Judge 決策歷程（${rows.length} 筆）：`,
              "",
              ...rows.map(
                (r) =>
                  `• [${r.recorded_at.slice(0, 16)}] 任務:${r.from_slug} → 採納:${r.to_slug}  信心:${(r.weight * 100).toFixed(0)}%`,
              ),
            ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 18：record_learning ──────────────────────────────────────
  server.registerTool(
    "record_learning",
    {
      title: "記錄學習事件",
      description:
        "記錄學習事件到 learning_events 表（activate / feedback / distill / tool_use 等）。",
      inputSchema: {
        patternSlug: z.string().optional(),
        cellSlug: z.string().optional(),
        eventType: z.string().describe("事件類型（例：activate / feedback / distill / tool_use）"),
        payload: z.record(z.string(), z.unknown()).optional().describe("附加資料（JSON 物件）"),
        source: z.string().optional().describe("來源（例：mcp / hook / cli）"),
      },
    },
    async ({ patternSlug, cellSlug, eventType, payload, source }) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO learning_events (id, pattern_slug, cell_slug, event_type, payload, source, recorded_at)
        VALUES (@id, @patternSlug, @cellSlug, @eventType, @payload, @source, @now)
      `).run({
        id,
        patternSlug: patternSlug ?? null,
        cellSlug: cellSlug ?? null,
        eventType,
        payload: payload ? JSON.stringify(payload) : null,
        source: source ?? null,
        now,
      });
      return {
        content: [
          { type: "text" as const, text: `✅ 學習事件已記錄（id: ${id}，type: ${eventType}）` },
        ],
      };
    },
  );

  // ── 工具 19：activate_pattern ─────────────────────────────────────
  server.registerTool(
    "activate_pattern",
    {
      title: "激活 Pattern",
      description: "激活 pattern，更新 last_activated + 重置 decay_score 為 1.0，並寫入學習事件。",
      inputSchema: {
        slug: z.string().describe("pattern slug"),
        context: z.string().optional().describe("本次激活的上下文描述"),
      },
    },
    async ({ slug, context }) => {
      const row = db.prepare(`SELECT * FROM patterns WHERE slug = ?`).get(slug) as
        | PatternRow
        | undefined;
      if (!row) {
        return {
          content: [{ type: "text" as const, text: `❌ 找不到 slug="${slug}" 的 pattern。` }],
        };
      }
      const prevDecayScore = row.decay_score;
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE patterns SET last_activated = ?, decay_score = 1.0, last_used = ?, updated_at = ? WHERE slug = ?`,
      ).run(now, now, now, slug);
      db.prepare(`
        INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
        VALUES (@id, @slug, 'activate', @payload, 'mcp', @now)
      `).run({
        id: crypto.randomUUID(),
        slug,
        payload: JSON.stringify({ context, prevDecayScore }),
        now,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ 已激活 pattern：${slug}\n   decay_score：${prevDecayScore} → 1.0`,
          },
        ],
      };
    },
  );

  // ── 工具 20：record_feedback ──────────────────────────────────────
  server.registerTool(
    "record_feedback",
    {
      title: "回饋評分",
      description: "為 pattern 評分（1-5），寫入 feedback 表並自動調整 decay_score。",
      inputSchema: {
        patternSlug: z.string(),
        rating: z.number().min(1).max(5).describe("評分 1-5"),
        comment: z.string().optional(),
      },
    },
    async ({ patternSlug, rating, comment }) => {
      const row = db.prepare(`SELECT decay_score FROM patterns WHERE slug = ?`).get(patternSlug) as
        | { decay_score: number }
        | undefined;
      if (!row) {
        return { content: [{ type: "text" as const, text: `❌ 找不到 pattern：${patternSlug}` }] };
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO feedback (id, pattern_slug, rating, comment, recorded_at)
        VALUES (@id, @patternSlug, @rating, @comment, @now)
      `).run({ id: crypto.randomUUID(), patternSlug, rating, comment: comment ?? null, now });
      let newDecay = row.decay_score;
      if (rating >= 4) {
        newDecay = Math.min(1.0, newDecay + 0.05);
      } else if (rating <= 2) {
        newDecay = Math.max(0, newDecay - 0.1);
      }
      db.prepare(`UPDATE patterns SET decay_score = ?, updated_at = ? WHERE slug = ?`).run(
        newDecay,
        now,
        patternSlug,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ 評分已記錄（${patternSlug}，${rating}/5）\n   decay_score：${row.decay_score.toFixed(3)} → ${newDecay.toFixed(3)}`,
          },
        ],
      };
    },
  );

  // ── 工具 21：query_patterns ───────────────────────────────────────
  server.registerTool(
    "query_patterns",
    {
      title: "搜尋 Patterns",
      description:
        "FTS5 全文搜尋 patterns（自動 fallback 到 LIKE 搜尋），支援 scope / confidence / frozen 過濾。",
      inputSchema: {
        query: z.string().describe("搜尋關鍵字"),
        scope: z.enum(["local", "global", "shared", "all"]).optional(),
        minConfidence: z.number().optional(),
        limit: z.number().optional(),
        includeFrozen: z.boolean().optional(),
      },
    },
    async ({ query, scope, minConfidence, limit = 20, includeFrozen = false }) => {
      let rows: PatternRow[];
      try {
        rows = db
          .prepare(
            `SELECT p.* FROM patterns_fts fts JOIN patterns p ON fts.rowid = p.rowid WHERE patterns_fts MATCH ? LIMIT ?`,
          )
          .all(query, limit) as PatternRow[];
      } catch {
        // fallback LIKE 搜尋
        const q = `%${query}%`;
        rows = db
          .prepare(
            `SELECT * FROM patterns WHERE lower(slug) LIKE ? OR lower(target) LIKE ? OR lower(context) LIKE ? LIMIT ?`,
          )
          .all(q, q, q, limit) as PatternRow[];
      }
      let results = rows.map(rowToPattern);
      if (scope && scope !== "all") {
        results = results.filter((p) => p.scope === scope);
      }
      if (minConfidence !== undefined) {
        results = results.filter((p) => p.confidence >= minConfidence);
      }
      if (!includeFrozen) {
        results = results.filter((p) => !p.frozen);
      }
      const text =
        results.length === 0
          ? `📭 找不到符合「${query}」的 pattern。`
          : [
              `🔍 搜尋結果（${results.length} 個）：`,
              "",
              ...results.map(
                (p) =>
                  `• ${p.slug.padEnd(20)} target：${p.target.slice(0, 20).padEnd(20)} ` +
                  `信心 ${(p.confidence * 100).toFixed(0).padStart(3)}%  ` +
                  `decay ${(p.decayScore ?? 1).toFixed(2)}  scope：${p.scope ?? "local"}`,
              ),
            ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 22：spawn_agent ──────────────────────────────────────────
  server.registerTool(
    "spawn_agent",
    {
      title: "組裝子代理呼叫指令",
      description:
        "組裝 Claude CLI / Codex CLI / OpenClaw 指令，或直接透過 Task Bus adapter 執行。",
      inputSchema: {
        agentType: z.enum(["claude", "codex", "openclaw"]),
        task: z.string(),
        role: z.enum(["reasoning", "technical", "pattern"]).optional(),
        model: z.string().optional().describe("claude: sonnet/haiku; codex: gpt-5.5"),
        contextJson: z.string().optional().describe("上下文 JSON 字串"),
        execute: z.boolean().optional().describe("true=實際執行（預設 false）"),
        timeoutMs: z.number().optional().describe("執行 timeout（毫秒，預設 30000）"),
      },
    },
    async ({ agentType, task, role, model, contextJson, execute = false, timeoutMs = 30_000 }) => {
      const roleDesc: Record<string, string> = {
        reasoning: "GoT 圖思維推理 / MAR 多代理反思",
        technical: "技術實作 / 程式碼生成 / 架構分析",
        pattern: "Pattern 蒸餾 / 知識管理 / 學習事件記錄",
      };
      let cmd: string;
      let outputFmt: string;
      if (agentType === "claude") {
        const modelFlag = model ? ` --model ${model}` : "";
        cmd = `claude -p "${task}"${modelFlag} --output-format json`;
        if (contextJson) {
          cmd += `\n# 注意：上下文 JSON 可透過 stdin 傳入：echo '${contextJson}' | claude -p "${task}"${modelFlag} --output-format json`;
        }
        outputFmt = "JSON（role / content / stop_reason）";
      } else if (agentType === "codex") {
        cmd = `codex exec --model ${model ?? "gpt-5.5"} --json "${task}"`;
        outputFmt = "JSON（choices / usage）";
      } else {
        cmd = `nuwa query --fts "${task}" --limit 5`;
        outputFmt = "Patterns 清單（slug / target / confidence）";
      }

      if (!execute) {
        const text = [
          `🤖 子代理建議指令（${agentType}${role ? ` / ${role}` : ""}）：`,
          ``,
          `\`\`\`sh`,
          cmd,
          `\`\`\``,
          ``,
          `角色描述：${role ? roleDesc[role] : "通用"}`,
          `預期輸出：${outputFmt}`,
          `執行模式：dry-run（未實際執行）`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      }

      const executionTask = contextJson ? `Context JSON:\n${contextJson}\n\nTask:\n${task}` : task;

      try {
        const rolePrompt = role ? `你的角色重點：${roleDesc[role]}` : undefined;
        let resultText = "";
        let meta = "";

        if (agentType === "claude") {
          const { callClaudeCli } =
            await import("../../../tools/openclaw_runtime/adapters/claude_code_cli_adapter.js");
          const claudeModel =
            model === "sonnet" || model === "haiku" || model === "opus" ? model : undefined;
          const r = await callClaudeCli(executionTask, {
            model: claudeModel,
            systemPrompt: rolePrompt,
            contextJson,
            timeoutMs,
          });
          resultText = r.result;
          meta = `cost=$${r.costUsd} duration=${r.durationMs}ms`;
        } else if (agentType === "codex") {
          const { callCodexCli } =
            await import("../../../tools/openclaw_runtime/adapters/codex_cli_adapter.js");
          const r = await callCodexCli(executionTask, { model, timeoutMs });
          resultText = r.result || r.rawOutput.slice(0, 1500);
          meta = `duration=${r.durationMs}ms events=${r.events.length}`;
        } else {
          const { callLocalModel } =
            await import("../../../tools/openclaw_runtime/adapters/local_model_adapter.js");
          const r = await callLocalModel(executionTask, {
            model,
            systemPrompt: rolePrompt,
            timeoutMs,
          });
          resultText = r.result;
          meta = `model=${r.model} duration=${r.durationMs}ms`;
        }

        const text = [
          `✅ 子代理已執行（${agentType}${role ? ` / ${role}` : ""}）`,
          `指令模板：${cmd}`,
          meta ? `執行資訊：${meta}` : "",
          "",
          `## 回傳結果`,
          resultText || "（無輸出）",
        ]
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `執行失敗：${String(err).slice(0, 300)}`,
            },
          ],
        };
      }
    },
  );

  // ── 工具 23：merge_patterns ───────────────────────────────────────
  server.registerTool(
    "merge_patterns",
    {
      title: "合併 Patterns",
      description: "將兩個相似 pattern 合併（低 confidence 的合入高 confidence 的）。",
      inputSchema: {
        sourceSlug: z.string().describe("要被合併掉的 pattern"),
        targetSlug: z.string().describe("合併目標（保留此 pattern）"),
        dryRun: z.boolean().optional().describe("true = 只預覽不執行"),
      },
    },
    async ({ sourceSlug, targetSlug, dryRun = false }) => {
      const src = db.prepare(`SELECT * FROM patterns WHERE slug = ?`).get(sourceSlug) as
        | PatternRow
        | undefined;
      const tgt = db.prepare(`SELECT * FROM patterns WHERE slug = ?`).get(targetSlug) as
        | PatternRow
        | undefined;
      if (!src) {
        return {
          content: [{ type: "text" as const, text: `❌ 找不到 source pattern：${sourceSlug}` }],
        };
      }
      if (!tgt) {
        return {
          content: [{ type: "text" as const, text: `❌ 找不到 target pattern：${targetSlug}` }],
        };
      }
      const srcMM = JSON.parse(src.mental_models) as string[];
      const tgtMM = JSON.parse(tgt.mental_models) as string[];
      const mergedMM = [...new Set([...tgtMM, ...srcMM])];
      const srcKw = JSON.parse(src.keywords) as string[];
      const tgtKw = JSON.parse(tgt.keywords) as string[];
      const mergedKw = [...new Set([...tgtKw, ...srcKw])];
      const newConf = Math.max(src.confidence, tgt.confidence);
      const newSampleCount = src.sample_count + tgt.sample_count;
      if (dryRun) {
        const text = [
          `🔍 合併預覽（dryRun=true，未執行）：`,
          `   source：${sourceSlug}（confidence=${src.confidence}，samples=${src.sample_count}）`,
          `   target：${targetSlug}（confidence=${tgt.confidence}，samples=${tgt.sample_count}）`,
          `   合併後 confidence：${newConf}`,
          `   合併後 sampleCount：${newSampleCount}`,
          `   合併後 mentalModels（${mergedMM.length}）：${mergedMM.slice(0, 3).join("、")}...`,
          `   合併後 keywords（${mergedKw.length}）：${mergedKw.slice(0, 5).join("、")}...`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      }
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE patterns SET confidence = ?, sample_count = ?, mental_models = ?, keywords = ?, updated_at = ? WHERE slug = ?`,
      ).run(
        newConf,
        newSampleCount,
        JSON.stringify(mergedMM),
        JSON.stringify(mergedKw),
        now,
        targetSlug,
      );
      db.prepare(`DELETE FROM patterns WHERE slug = ?`).run(sourceSlug);
      db.prepare(
        `INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at) VALUES (@id, @slug, 'merge', @payload, 'mcp', @now)`,
      ).run({
        id: crypto.randomUUID(),
        slug: targetSlug,
        payload: JSON.stringify({ sourceSlug, newConf, newSampleCount }),
        now,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ 合併完成：${sourceSlug} → ${targetSlug}\n   confidence：${newConf}  sampleCount：${newSampleCount}`,
          },
        ],
      };
    },
  );

  // ── 工具 24：save_conversation ────────────────────────────────────
  server.registerTool(
    "save_conversation",
    {
      title: "儲存對話摘要",
      description: "壓縮對話摘要存入 conversations 表。",
      inputSchema: {
        sessionId: z.string(),
        summary: z.string().describe("300 字以內摘要"),
        participants: z.array(z.string()).optional(),
        topic: z.string().optional(),
        roleAssignments: z
          .record(z.string(), z.string())
          .optional()
          .describe("{ claude: 'CTO', user: 'Engineer' }"),
        dialogueMode: z.enum(["normal", "role-play", "debate", "interview"]).optional(),
        startedAt: z.string().optional(),
      },
    },
    async ({
      sessionId,
      summary,
      participants,
      topic,
      roleAssignments,
      dialogueMode,
      startedAt,
    }) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO conversations (id, session_id, summary, participants, topic, role_assignments, dialogue_mode, started_at, created_at)
        VALUES (@id, @sessionId, @summary, @participants, @topic, @roleAssignments, @dialogueMode, @startedAt, @now)
      `).run({
        id,
        sessionId,
        summary,
        participants: participants ? JSON.stringify(participants) : null,
        topic: topic ?? null,
        roleAssignments: roleAssignments ? JSON.stringify(roleAssignments) : null,
        dialogueMode: dialogueMode ?? null,
        startedAt: startedAt ?? now,
        now,
      });
      return {
        content: [
          { type: "text" as const, text: `✅ 對話摘要已儲存（id: ${id}，session: ${sessionId}）` },
        ],
      };
    },
  );

  // ── 工具 25：list_debates ─────────────────────────────────────────
  server.registerTool(
    "list_debates",
    {
      title: "查詢 DMAD 辯論歷程",
      description: "列出歷史 DMAD 辯論記錄，可按收斂分篩選。",
      inputSchema: {
        limit: z.number().optional(),
        minConvergence: z.number().optional().describe("最低收斂分篩選"),
      },
    },
    async ({ limit = 20, minConvergence }) => {
      const conditions: string[] = [];
      const params: Array<number> = [];
      if (minConvergence !== undefined) {
        conditions.push("convergence_score >= ?");
        params.push(minConvergence);
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT task, rounds_count, convergence_score, stopped_by, pattern_slugs_used, started_at
         FROM debates ${whereClause}
         ORDER BY started_at DESC LIMIT ?`,
        )
        .all(...params, limit) as Array<{
        task: string;
        rounds_count: number;
        convergence_score: number | null;
        stopped_by: string | null;
        pattern_slugs_used: string | null;
        started_at: string;
      }>;
      const text =
        rows.length === 0
          ? "📭 尚無辯論記錄。"
          : [
              `⚔️ DMAD 辯論歷程（${rows.length} 筆）：`,
              "",
              ...rows.map((r) => {
                let patterns = "";
                try {
                  patterns = (JSON.parse(r.pattern_slugs_used ?? "[]") as string[]).join(", ");
                } catch {
                  patterns = "";
                }
                return (
                  `• [${r.started_at.slice(0, 10)}] ${r.task.slice(0, 60)}\n  ` +
                  `rounds=${r.rounds_count}  收斂=${((r.convergence_score ?? 0) * 100).toFixed(0)}%` +
                  `  停止：${r.stopped_by ?? "?"}  patterns：${patterns || "無"}`
                );
              }),
            ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 26：recall_context ───────────────────────────────────────
  server.registerTool(
    "recall_context",
    {
      title: "語義搜尋歷史對話",
      description: "從 conversations 表搜尋歷史對話（語義重排優先，失敗時 fallback LIKE）。",
      inputSchema: {
        query: z.string().describe("搜尋關鍵字"),
        limit: z.number().optional(),
        dialogueMode: z.string().optional(),
      },
    },
    async ({ query, limit = 10, dialogueMode }) => {
      // 先用 LIKE 撈候選（最多 200 筆），再用 TF-IDF 語義重排
      type ConvRow = {
        id: string;
        summary: string;
        topic: string | null;
        dialogue_mode: string | null;
        started_at: string;
      };
      let allRows = db
        .prepare(
          `SELECT id, summary, topic, dialogue_mode, started_at FROM conversations WHERE summary IS NOT NULL AND summary != '' ORDER BY started_at DESC LIMIT 200`,
        )
        .all() as ConvRow[];
      if (dialogueMode) {
        allRows = allRows.filter((r) => r.dialogue_mode === dialogueMode);
      }

      let rows: ConvRow[];
      if (allRows.length === 0) {
        rows = [];
      } else {
        try {
          // 語義重排（TF-IDF，若 Ollama/Xenova 可用則自動升級）
          const { semanticSearchPatterns } = await import("../src/embedding.js");
          const candidates = allRows.map((r) => ({ slug: r.id, text: r.summary }));
          const results = await semanticSearchPatterns(query, candidates, limit);
          const idToRow = new Map(allRows.map((r) => [r.id, r]));
          rows = results.map((r) => idToRow.get(r.slug)).filter(Boolean) as ConvRow[];
        } catch {
          // Embedder 失敗，fallback LIKE
          const q = `%${query}%`;
          rows = (
            db
              .prepare(
                `SELECT id, summary, topic, dialogue_mode, started_at FROM conversations WHERE summary LIKE ? ORDER BY started_at DESC LIMIT ?`,
              )
              .all(q, limit) as ConvRow[]
          ).filter((r) => !dialogueMode || r.dialogue_mode === dialogueMode);
        }
      }

      const text =
        rows.length === 0
          ? `📭 找不到與「${query}」相關的對話記錄。`
          : [
              `🧠 歷史對話（${rows.length} 筆）：`,
              "",
              ...rows.map(
                (r) =>
                  `• [${r.started_at.slice(0, 10)}]${r.topic ? ` ${r.topic}` : ""}  ` +
                  `[${r.dialogue_mode ?? "normal"}]\n  ${r.summary.slice(0, 150)}${r.summary.length > 150 ? "…" : ""}`,
              ),
            ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 27：run_cognitive_cycle（ABCD 統合認知迴圈）─────────────────
  server.registerTool(
    "run_cognitive_cycle",
    {
      title: "ABCD 統合認知迴圈",
      description:
        "執行完整 ABCD 四層認知迴圈：D(憲法同步) → C(GoT圖思維) → B(MAR多角色反思) → MoA聚合。" +
        "回傳 prompt 與摘要供 MCP 依序呼叫模型。",
      inputSchema: {
        task: z.string().describe("任務描述"),
        taskType: z
          .enum([
            "architecture",
            "security",
            "cost_optimization",
            "code_quality",
            "agent_design",
            "general",
          ])
          .describe("任務類型"),
        proposal: z.string().describe("初始提案（由呼叫者先產生）"),
        learningStatePath: z.string().optional().describe("learning-state.json 路徑"),
      },
    },
    async ({ task, taskType, proposal, learningStatePath }) => {
      const { runCognitiveCycle } = await import("../src/cognitive-cycle.js");
      const result = await runCognitiveCycle({
        task,
        taskType,
        proposal,
        db,
        learningStatePath,
      });

      const text = [
        `🧠 ABCD 認知迴圈完成`,
        `GoT 節點：${result.stats.gotNodes}  批評者：${result.stats.critics}  重試：${result.stats.retries}`,
        `費用估算：$${result.stats.totalEstimatedCostUsd}  MAR跳過：${result.stats.skippedMAR}`,
        ``,
        `## GoT 遍歷策略`,
        result.got.strategy,
        ``,
        `## MoA 聚合 Prompt（節錄）`,
        result.prompts.moaPrompt.slice(0, 1000),
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 28：check_risk_gate（⑯ Hermes interrupt 審批閘道）──────────
  server.registerTool(
    "check_risk_gate",
    {
      title: "Hermes 風險審批閘道",
      description:
        "分析任務風險等級（read_only/local_write/external_write/trading_payment/credential），" +
        "高風險任務需人工確認（interrupt()）。MCP 環境自動拒絕，CLI 互動環境顯示確認提示。" +
        "拒絕後自動寫入 Hermes failure 記錄。",
      inputSchema: {
        task: z.string().describe("任務描述（用於分析風險等級）"),
        preview: z.string().optional().describe("操作摘要（供使用者確認）"),
        source: z.string().optional().describe("任務來源（claude_cli/codex/mcp_tool）"),
        forceRisk: z
          .enum(["read_only", "local_write", "external_write", "trading_payment", "credential"])
          .optional()
          .describe("強制指定風險等級（若已知則不需自動偵測）"),
      },
    },
    async ({ task, preview, source, forceRisk }) => {
      const gate = createHermesGate(db, stateDir);
      const riskClass = forceRisk ?? hermesClassifyRisk(task);
      const decision = await gate.checkRisk({ task, preview, source, riskClass });
      const emoji = {
        read_only: "✅",
        local_write: "📝",
        external_write: "⚠️",
        trading_payment: "🚨",
        credential: "🔐",
      }[decision.riskClass];
      const text = [
        `${emoji} Hermes 風險閘道：${decision.riskClass}`,
        `狀態：${decision.allowed ? "✅ 放行" : "🚫 拒絕"}`,
        `原因：${decision.reason}`,
        `traceId：${decision.traceId}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── 工具 29：run_dmad_debate ─────────────────────────────────────────
  server.registerTool(
    "run_dmad_debate",
    {
      title: "DMAD 三代理辯論",
      description:
        "執行 DMAD（Diversity-enhanced Multi-Agent Debate）三代理辯論（Claude + Codex + OpenClaw），" +
        "強制不同角度推理，MoA 聚合最終答案。最多 3 輪，自動收斂偵測。",
      inputSchema: {
        task: z.string().describe("辯論主題或任務描述"),
        maxRounds: z.number().min(1).max(5).optional().describe("最大輪次（預設 3）"),
        convergenceThreshold: z.number().min(0).max(1).optional().describe("收斂閾值（預設 0.93）"),
        claudeModel: z.string().optional().describe("Claude 模型（預設 claude-haiku-4-5）"),
        codexModel: z.string().optional().describe("Codex 模型（預設 gpt-4.5）"),
        timeoutMs: z.number().optional().describe("每輪 timeout ms（預設 30000）"),
      },
    },
    async ({ task, maxRounds, convergenceThreshold, claudeModel, codexModel, timeoutMs }) => {
      const result = await runDMAD(task, db, {
        maxRounds,
        convergenceThreshold,
        claudeModel,
        codexModel,
        timeoutMs,
      });
      const text = [
        `🎭 DMAD 辯論完成（${result.totalRounds} 輪，停止原因：${result.stoppedBy}）`,
        `收斂分：${result.convergenceScore.toFixed(2)}  費用估算：$${result.estimatedCostUsd}`,
        `激活 patterns：${result.patternSlugsUsed.join(", ") || "無"}`,
        "",
        `## MoA 最終答案`,
        result.finalAnswer,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── Prompts（⑧）：已安裝 pattern → 自動 MCP Prompt ─────────────────
  // 每個 pattern 變成一個可直接呼叫的 prompt template
  // Claude Code 使用者可透過 /prompt nuwa-<slug> 直接套用認知框架
  {
    type PromptPatternRow = {
      slug: string;
      target: string;
      context: string | null;
      mental_models: string | null;
      keywords: string | null;
      confidence: number;
      parent_slug: string | null;
    };
    const allPatterns = db
      .prepare(
        "SELECT slug, target, context, mental_models, keywords, confidence, parent_slug FROM patterns WHERE frozen = 0 ORDER BY decay_score DESC LIMIT 50",
      )
      .all() as PromptPatternRow[];

    for (const p of allPatterns) {
      let mentalModelsList: string[] = [];
      let keywordsList: string[] = [];
      try {
        mentalModelsList = JSON.parse(p.mental_models ?? "[]");
      } catch {
        /* ignore */
      }
      try {
        keywordsList = JSON.parse(p.keywords ?? "[]");
      } catch {
        /* ignore */
      }

      // 繼承父 pattern 的心智模型（最多往上 2 層）
      let parentSlug = p.parent_slug ?? null;
      let depth = 0;
      while (parentSlug && depth < 2) {
        const parent = db
          .prepare("SELECT mental_models, parent_slug FROM patterns WHERE slug = ?")
          .get(parentSlug) as
          | { mental_models: string | null; parent_slug: string | null }
          | undefined;
        if (!parent) {
          break;
        }
        try {
          const parentModels = JSON.parse(parent.mental_models ?? "[]") as string[];
          for (const model of parentModels) {
            const inherited = `[繼承] ${model}`;
            if (!mentalModelsList.includes(model) && !mentalModelsList.includes(inherited)) {
              mentalModelsList.push(inherited);
            }
          }
        } catch {
          // 忽略父層 JSON 異常
        }
        parentSlug = parent.parent_slug;
        depth++;
      }

      server.registerPrompt(
        `nuwa-${p.slug}`,
        {
          title: `[nuwa] ${p.target}`,
          description: `女媧認知框架：${p.target}（信心分 ${(p.confidence * 100).toFixed(0)}%）`,
          argsSchema: {
            task: z.string().describe("你要用這個框架處理的任務或問題"),
          },
        },
        ({ task }: { task: string }) => ({
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: [
                  `# 女媧認知框架：${p.target}`,
                  "",
                  p.context ? `## 框架說明\n${p.context}` : "",
                  mentalModelsList.length > 0
                    ? `## 心智模型\n${mentalModelsList.map((m: string) => `- ${m}`).join("\n")}`
                    : "",
                  keywordsList.length > 0 ? `## 關鍵概念\n${keywordsList.join(" / ")}` : "",
                  "",
                  `## 當前任務\n${task}`,
                  "",
                  `請使用以上認知框架分析並回應任務。`,
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            },
          ],
        }),
      );
    }
  }

  // ── Resources ────────────────────────────────────────────────────

  // Resource 1：nuwa://patterns — 所有 patterns JSON
  server.registerResource(
    "nuwa-patterns",
    "nuwa://patterns",
    {
      title: "女媧 Patterns 資料庫",
      description: "所有已蒸餾的 NuwaPattern 完整 JSON 清單。",
      mimeType: "application/json",
    },
    async (_uri) => {
      const patterns = readPatterns(db, undefined, 10000);
      return {
        contents: [
          {
            uri: "nuwa://patterns",
            mimeType: "application/json",
            text: JSON.stringify(patterns, null, 2),
          },
        ],
      };
    },
  );

  // Resource 2：nuwa://analytics — 統計概覽
  server.registerResource(
    "nuwa-analytics",
    "nuwa://analytics",
    {
      title: "女媧 Analytics",
      description: "Pattern 數、Cell 數、各狀態分布、最近 5 筆 learning_events。",
      mimeType: "application/json",
    },
    async (_uri) => {
      const patternCount = (
        db.prepare("SELECT COUNT(*) as cnt FROM patterns").get() as { cnt: number }
      ).cnt;
      const cellCount = (
        db.prepare("SELECT COUNT(*) as cnt FROM stem_cells").get() as { cnt: number }
      ).cnt;
      const frozenCount = (
        db.prepare("SELECT COUNT(*) as cnt FROM patterns WHERE frozen = 1").get() as { cnt: number }
      ).cnt;
      const statusDist = db
        .prepare("SELECT status, COUNT(*) as cnt FROM stem_cells GROUP BY status")
        .all() as Array<{ status: string; cnt: number }>;
      const recentEvents = db
        .prepare(
          "SELECT event_type, pattern_slug, source, recorded_at FROM learning_events ORDER BY recorded_at DESC LIMIT 5",
        )
        .all();
      const analytics = {
        patternCount,
        frozenCount,
        cellCount,
        cellStatusDistribution: statusDist,
        recentLearningEvents: recentEvents,
      };
      return {
        contents: [
          {
            uri: "nuwa://analytics",
            mimeType: "application/json",
            text: JSON.stringify(analytics, null, 2),
          },
        ],
      };
    },
  );

  // Resource 3：nuwa://health — DB 健康狀態
  server.registerResource(
    "nuwa-health",
    "nuwa://health",
    {
      title: "女媧 DB 健康狀態",
      description: "資料庫表數、各表記錄數、最後更新時間。",
      mimeType: "application/json",
    },
    async (_uri) => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const tableCounts: Record<string, number> = {};
      for (const t of tables) {
        try {
          tableCounts[t.name] = (
            db.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get() as { cnt: number }
          ).cnt;
        } catch {
          tableCounts[t.name] = -1;
        }
      }
      const lastUpdated = (
        db.prepare("SELECT MAX(updated_at) as ts FROM patterns").get() as { ts: string | null }
      ).ts;
      const health = {
        tableCount: tables.length,
        tableCounts,
        lastPatternUpdate: lastUpdated,
        stateDir,
      };
      return {
        contents: [
          {
            uri: "nuwa://health",
            mimeType: "application/json",
            text: JSON.stringify(health, null, 2),
          },
        ],
      };
    },
  );

  // Resource 4：nuwa://personas — 所有 personas JSON（含 fitness_score）
  server.registerResource(
    "nuwa-personas",
    "nuwa://personas",
    {
      title: "女媧 Personas 庫",
      description: "所有角色定義 JSON（含 fitness_score）。",
      mimeType: "application/json",
    },
    async (_uri) => {
      const personas = db.prepare("SELECT * FROM personas ORDER BY fitness_score DESC").all();
      return {
        contents: [
          {
            uri: "nuwa://personas",
            mimeType: "application/json",
            text: JSON.stringify(personas, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

// ─── Hono HTTP 應用 ──────────────────────────────────────────────────

const WORKSPACE_DIR = process.env.NUWA_WORKSPACE ?? process.cwd();
const STATE_DIR = resolveStateDir(WORKSPACE_DIR);
const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 34821;

// SQLite DB 實例（進程生命週期共享）
const nuwaDb = openDb(STATE_DIR);

const app = new Hono();

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port);
  });
}

async function fetchExistingServerHealth(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) {
      return null;
    }
    const payload = await res.json();
    if (payload && typeof payload === "object") {
      return payload as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function closeNuwaDbSafely(): void {
  try {
    nuwaDb.local.close();
  } catch {
    // ignore close errors
  }
  try {
    nuwaDb.global.close();
  } catch {
    // ignore close errors
  }
}

// CORS（允許 Claude Code CLI / OpenClaw 跨來源連接）
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  }),
);

// 健康檢查
app.get("/health", (c) =>
  c.json({
    status: "ok",
    server: "nuwa-evolution-learning",
    version: "2026.5.5",
    stateDir: STATE_DIR,
    workspace: WORKSPACE_DIR,
    billing: process.env.NUWA_BILLING ?? "subscription",
    port: PORT,
    storage: "sqlite-wal",
  }),
);

// 費用狀態（快速查看，不需 MCP 客戶端）
app.get("/cost", async (c) => {
  const guard = createCostGuard(STATE_DIR);
  const summary = await guard.monthlySummary();
  return c.json({ billing: await guard.getBillingInfo(), ...summary });
});

// MCP 主要端點（stateless，每個 request 建立新的 McpServer 實例，共享 DB 實例）
app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createNuwaMcpServer(STATE_DIR, nuwaDb.local);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// ─── 啟動 ────────────────────────────────────────────────────────────

console.log(`🏺 nuwa MCP Server 啟動中...`);
console.log(`   工作目錄  ：${WORKSPACE_DIR}`);
console.log(`   狀態目錄  ：${STATE_DIR}`);
console.log(`   計費模式  ：${process.env.NUWA_BILLING ?? "subscription"}`);
console.log(`   Port      ：${PORT}`);
console.log(`   資料儲存  ：SQLite WAL`);

async function bootstrap(): Promise<void> {
  const portAvailable = await isPortAvailable(PORT);
  if (!portAvailable) {
    const existingHealth = await fetchExistingServerHealth(PORT);
    console.warn(`⚠️ Port ${PORT} 已被占用，避免重複啟動。`);
    if (existingHealth) {
      console.warn(`✅ 已偵測到既有 nuwa MCP 實例，沿用現有服務：`);
      console.warn(`   health=${JSON.stringify(existingHealth)}`);
    } else {
      console.warn(`⚠️ 無法讀取現有 /health，但為避免崩潰，本次安全退出。`);
    }
    closeNuwaDbSafely();
    process.exitCode = 0;
    return;
  }

  // 啟動時自動遷移舊 JSON/JSONL → SQLite
  migrateIfNeeded(STATE_DIR, nuwaDb.local)
    .then((result) => {
      if (result.skipped) {
        console.log(`\n✅ SQLite 已初始化（遷移標記存在，略過遷移）`);
      } else {
        console.log(
          `\n✅ SQLite 遷移完成：` +
            `patterns=${result.patterns} cells=${result.cells} seeded=${result.seeded} ` +
            `personas=${result.seededPersonas} constitution=${result.seededConstitution}`,
        );
        if (result.errors.length > 0) {
          console.warn(`   ⚠️  非致命錯誤 ${result.errors.length} 個：`, result.errors);
        }
      }

      console.log(``);
      console.log(`🔗 端點：`);
      console.log(`   健康檢查  ：http://localhost:${PORT}/health`);
      console.log(`   費用狀態  ：http://localhost:${PORT}/cost`);
      console.log(`   MCP       ：http://localhost:${PORT}/mcp`);
      console.log(``);
      console.log(`📋 Claude Code CLI 設定（~/.claude/settings.json）：`);
      console.log(`   {`);
      console.log(`     "mcpServers": {`);
      console.log(`       "nuwa": {`);
      console.log(`         "type": "http",`);
      console.log(`         "url": "http://localhost:${PORT}/mcp"`);
      console.log(`       }`);
      console.log(`     }`);
      console.log(`   }`);
      console.log(``);

      // 啟動 Croner 背景排程
      startCroner(nuwaDb.local, STATE_DIR);
      console.log(`⏰ Croner 排程已啟動（REM 衰減 / GC / 演化週期）`);
    })
    .catch((err) => {
      console.error(`❌ SQLite 遷移失敗：`, err);
      // 遷移失敗不中斷 server 啟動
    });

  serve({ fetch: app.fetch, port: PORT });
}

void bootstrap().catch((err) => {
  console.error(`❌ nuwa MCP 啟動失敗：`, err);
  closeNuwaDbSafely();
  process.exitCode = 1;
});
