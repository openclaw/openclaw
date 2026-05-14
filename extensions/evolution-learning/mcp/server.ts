/**
 * nuwa MCP Server — Streamable HTTP
 *
 * 使用 Hono + @modelcontextprotocol/sdk WebStandardStreamableHTTPServerTransport
 * 讓 Claude Code CLI / 任何 MCP 客戶端 都能使用 nuwa 進化學習工具。
 *
 * 啟動：
 *   MCP_PORT=3741 npx tsx mcp/server.ts
 *
 * 在 claude_desktop_config.json 或 Claude Code settings.json 中設定：
 *   {
 *     "mcpServers": {
 *       "nuwa": {
 *         "type": "http",
 *         "url": "http://localhost:3741/mcp"
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
 */

import fs from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createCostGuard } from "../src/cost-guard.js";
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

// ─── 工具函數 ───────────────────────────────────────────────────────

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
  if (!content) return [];
  const result: NuwaPattern[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
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
  if (!content) return null;
  try {
    return JSON.parse(content) as CellRegistry;
  } catch {
    return null;
  }
}

async function writePatterns(stateDir: string, patterns: NuwaPattern[]): Promise<void> {
  await fs.writeFile(
    path.join(stateDir, "patterns.jsonl"),
    patterns.map((p) => JSON.stringify(p)).join("\n") + "\n",
    "utf8",
  );
}

async function writeRegistry(stateDir: string, reg: CellRegistry): Promise<void> {
  await fs.writeFile(
    path.join(stateDir, "cell-registry.json"),
    JSON.stringify(reg, null, 2) + "\n",
    "utf8",
  );
}

// ─── MCP Server 工廠（每 request 建一個，stateless）────────────────

function createNuwaMcpServer(stateDir: string): McpServer {
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
    async ({ workspace }) => {
      const dir = resolveStateDir(workspace);
      const patterns = await readPatterns(dir);
      const reg = await readRegistry(dir);
      const cells = reg?.stemCells ?? [];

      const status = {
        stateDir: dir,
        patterns: patterns.length,
        frozenPatterns: patterns.filter((p) => p.frozen).length,
        cells: {
          installed: cells.filter((c) => c.status === "installed").length,
          ready: cells.filter((c) => c.status === "ready").length,
          incubating: cells.filter((c) => c.status === "incubating").length,
          embryo: cells.filter((c) => c.status === "embryo").length,
        },
        billing: await guard.getBillingInfo(),
        topPatterns: [...patterns]
          .sort((a, b) => b.sampleCount - a.sampleCount)
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
              `📁 狀態目錄：${status.stateDir}`,
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
    async ({ workspace, filter, limit = 20 }) => {
      const dir = resolveStateDir(workspace);
      let patterns = await readPatterns(dir);

      if (filter) {
        const f = filter.toLowerCase();
        patterns = patterns.filter((p) => p.slug.includes(f) || p.target.toLowerCase().includes(f));
      }

      const result = patterns.slice(0, limit);

      return {
        content: [
          {
            type: "text" as const,
            text:
              result.length === 0
                ? "📭 找不到符合條件的 pattern。"
                : [
                    `🧠 女媧模式（${result.length}/${patterns.length} 個）：`,
                    "",
                    ...result.map(
                      (p) =>
                        `• ${p.target.padEnd(16)} ` +
                        `信心 ${(p.confidence * 100).toFixed(0).padStart(3)}%  ` +
                        `使用 ${String(p.sampleCount).padStart(4)} 次  ` +
                        `slug: ${p.slug}` +
                        (p.frozen ? "  🔒" : "") +
                        (p.skillPath ? "  📄" : ""),
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
    async ({ workspace, status = "all" }) => {
      const dir = resolveStateDir(workspace);
      const reg = await readRegistry(dir);
      let cells = reg?.stemCells ?? [];

      if (status !== "all") {
        cells = cells.filter((c) => c.status === status);
      }

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
      },
    },
    async ({ target, workspace, tavilyKey, keywords: manualKeywords, mentalModels: manualMM }) => {
      const dir = resolveStateDir(workspace);

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
      const id = `${slug}-mcp-v${Date.now()}`;

      let keywords: string[] = manualKeywords ?? [target, slug];
      let mentalModels: string[] = manualMM ?? [`${target} 思維框架`, `${target} 核心原則`];
      let confidence = 0.45;

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
              .sort((a, b) => b[1] - a[1])
              .slice(0, 12)
              .map(([w]) => w)
              .concat([target, slug]);
            confidence = 0.55;
          }
        } catch {
          /* fallback */
        }
      }

      const pattern: NuwaPattern = {
        id,
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
      };

      const patternsPath = path.join(dir, "patterns.jsonl");
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(patternsPath, JSON.stringify(pattern) + "\n", "utf8");

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `🧬 蒸餾完成：`,
              `   target  ：${target}`,
              `   slug    ：${slug}`,
              `   id      ：${id}`,
              `   信心度  ：${(confidence * 100).toFixed(0)}%`,
              `   關鍵字  ：${keywords.slice(0, 5).join("、")}...`,
              `   心智模型：${mentalModels.join("、")}`,
              `   寫入    ：${patternsPath}`,
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
      description: "凍結 pattern 以停止代謝衰減，或解凍恢復正常代謝。零成本操作。",
      inputSchema: {
        slug: z.string().describe("要凍結的 pattern slug"),
        workspace: z.string().optional(),
        unfreeze: z.boolean().optional().describe("true = 解凍（預設 false = 凍結）"),
      },
    },
    async ({ slug, workspace, unfreeze = false }) => {
      const dir = resolveStateDir(workspace);
      const patterns = await readPatterns(dir);
      const idx = patterns.findIndex((p) => p.slug === slug || p.id === slug);

      if (idx < 0) {
        return {
          content: [{ type: "text" as const, text: `❌ 找不到 slug="${slug}" 的 pattern。` }],
        };
      }

      patterns[idx].frozen = !unfreeze;
      await writePatterns(dir, patterns);

      return {
        content: [
          {
            type: "text" as const,
            text: `${unfreeze ? "🔓 已解凍" : "🔒 已凍結"} pattern：${slug}`,
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
      const dir = resolveStateDir(workspace);
      const patterns = await readPatterns(dir);
      const pattern = patterns.find((p) => p.slug === slug);

      if (!pattern) {
        return {
          content: [{ type: "text" as const, text: `❌ 找不到 slug="${slug}" 的 pattern。` }],
        };
      }

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

      const pidx = patterns.findIndex((p) => p.slug === slug);
      if (pidx >= 0) {
        patterns[pidx].skillPath = path.relative(workspaceDir, skillPath).replace(/\\/g, "/");
        await writePatterns(dir, patterns);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [`🐣 孵化完成：`, `   技能文件：${skillPath}`, `   skillPath 已更新`].join("\n"),
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
      const guard = createCostGuard(dir);
      const reg = createSubscriptionRegistry(dir);
      const summary = await guard.monthlySummary();
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

  return server;
}

// ─── Hono HTTP 應用 ──────────────────────────────────────────────────

const WORKSPACE_DIR = process.env.NUWA_WORKSPACE ?? process.cwd();
const STATE_DIR = resolveStateDir(WORKSPACE_DIR);
const PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3741;

const app = new Hono();

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
  }),
);

// 費用狀態（快速查看，不需 MCP 客戶端）
app.get("/cost", async (c) => {
  const guard = createCostGuard(STATE_DIR);
  const summary = await guard.monthlySummary();
  return c.json({ billing: await guard.getBillingInfo(), ...summary });
});

// MCP 主要端點（stateless，每個 request 建立新的 server 實例）
app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createNuwaMcpServer(STATE_DIR);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// ─── 啟動 ────────────────────────────────────────────────────────────

console.log(`🏺 nuwa MCP Server 啟動中...`);
console.log(`   工作目錄  ：${WORKSPACE_DIR}`);
console.log(`   狀態目錄  ：${STATE_DIR}`);
console.log(`   計費模式  ：${process.env.NUWA_BILLING ?? "subscription"}`);
console.log(`   Port      ：${PORT}`);
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

serve({ fetch: app.fetch, port: PORT });
