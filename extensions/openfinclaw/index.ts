/**
 * OpenFinClaw — Skill publishing, strategy validation, and fork tools.
 * Tools: skill_leaderboard, skill_get_info, skill_validate, skill_fork, skill_list_local, skill_publish, skill_publish_verify.
 * Supports FEP v2.0 protocol for strategy packages.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { registerStrategyCli } from "./src/cli.js";
import { forkStrategy, fetchStrategyInfo } from "./src/fork.js";
import { listLocalStrategies, findLocalStrategy } from "./src/strategy-storage.js";
import type { BoardType, LeaderboardResponse, LeaderboardStrategy } from "./src/types.js";
import { validateStrategyPackage } from "./src/validate.js";

/** JSON tool result helper. */
function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

/** Resolved plugin config for skill API. */
type SkillApiConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  requestTimeoutMs: number;
};

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve config from plugin config and env.
 */
function resolveConfig(api: OpenClawPluginApi): SkillApiConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;
  const baseUrl =
    (typeof raw?.skillApiUrl === "string" ? raw.skillApiUrl : undefined) ??
    readEnv(["SKILL_API_URL", "SKILL_API_BASE_URL"]) ??
    "https://hub.openfinclaw.ai";
  const apiKey =
    (typeof raw?.skillApiKey === "string" ? raw.skillApiKey : undefined) ??
    readEnv(["SKILL_API_KEY"]);
  const timeoutRaw = raw?.requestTimeoutMs ?? readEnv(["SKILL_REQUEST_TIMEOUT_MS"]);
  const requestTimeoutMs =
    Number(timeoutRaw) >= 5000 && Number(timeoutRaw) <= 300_000
      ? Math.floor(Number(timeoutRaw))
      : 60_000;

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
    requestTimeoutMs,
  };
}

/**
 * HTTP request helper with Bearer auth.
 * Base path is /api/v1.
 */
async function skillApiRequest(
  config: SkillApiConfig,
  method: "GET" | "POST",
  pathSegments: string,
  options?: { body?: Record<string, unknown>; searchParams?: Record<string, string> },
): Promise<{ status: number; data: unknown }> {
  const url = new URL(`${config.baseUrl}/api/v1${pathSegments}`);
  if (options?.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  let body: string | undefined;
  if (options?.body) {
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const rawText = await response.text();
  let data: unknown = rawText;
  if (rawText && rawText.trim().startsWith("{")) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }
  }

  return { status: response.status, data };
}

const openfinclawPlugin = {
  id: "openfinclaw",
  name: "OpenFinClaw",
  description:
    "Strategy publishing, fork, and validation tools. Publish strategy ZIPs to Hub, fork public strategies to local, and validate strategy packages.",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);

    // ── skill_publish ──
    api.registerTool(
      {
        name: "skill_publish",
        label: "Publish skill to server",
        description:
          "Publish a strategy ZIP to the skill server. The server will automatically run backtest. Returns submissionId and backtestTaskId for polling. Use skill_publish_verify to check status and get report when completed.",
        parameters: Type.Object({
          filePath: Type.String({
            description: "Path to the strategy ZIP file (must contain fep.yaml)",
          }),
          visibility: Type.Optional(
            Type.Unsafe<"public" | "private" | "unlisted">({
              type: "string",
              enum: ["public", "private", "unlisted"],
              description: "Override visibility from fep.yaml: public, private, or unlisted",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const filePath = String(params.filePath ?? "").trim();
            if (!filePath) {
              return json({ success: false, error: "filePath is required" });
            }

            if (!config.apiKey) {
              return json({
                success: false,
                error:
                  "API key not configured. Set skillApiKey in plugin config or SKILL_API_KEY env.",
              });
            }

            const resolvedPath = api.resolvePath(filePath);
            const buf = await readFile(resolvedPath);
            const base64Content = buf.toString("base64");

            const body: Record<string, unknown> = { content: base64Content };
            if (
              params.visibility === "public" ||
              params.visibility === "private" ||
              params.visibility === "unlisted"
            ) {
              body.visibility = params.visibility;
            }

            const { status, data } = await skillApiRequest(config, "POST", "/skill/publish", {
              body,
            });

            if (status >= 200 && status < 300) {
              const resp = data as {
                slug?: string;
                entryId?: string;
                version?: string;
                status?: string;
                message?: string;
                submissionId?: string;
                backtestTaskId?: string | null;
                backtestStatus?: string | null;
                backtestReport?: unknown;
                creditsEarned?: { action?: string; amount?: number; message?: string };
              };

              const lines: string[] = [];
              lines.push("Skill 发布成功！");
              lines.push("");
              lines.push(`- Slug: ${resp.slug ?? "(未知)"}`);
              lines.push(`- Entry ID: ${resp.entryId ?? "(未知)"}`);
              lines.push(`- Version: ${resp.version ?? "(未知)"}`);
              lines.push(`- Status: ${resp.status ?? "(未知)"}`);
              if (resp.message) {
                lines.push(`- Message: ${resp.message}`);
              }
              lines.push("");
              lines.push(`- Submission ID: ${resp.submissionId ?? "(未知)"}`);
              if (resp.backtestTaskId) {
                lines.push(`- Backtest Task ID: ${resp.backtestTaskId}`);
              }
              if (resp.backtestStatus) {
                lines.push(`- Backtest Status: ${resp.backtestStatus}`);
              }
              if (resp.creditsEarned) {
                lines.push("");
                lines.push("积分奖励:");
                if (resp.creditsEarned.amount) {
                  lines.push(`- 获得 ${resp.creditsEarned.amount} FC`);
                }
                if (resp.creditsEarned.message) {
                  lines.push(`- ${resp.creditsEarned.message}`);
                }
              }
              lines.push("");
              lines.push("使用 skill_publish_verify 工具查询回测状态和获取完整报告。");

              return {
                content: [{ type: "text" as const, text: lines.join("\n") }],
                details: { success: true, ...resp },
              };
            }

            return json({
              success: false,
              status,
              error:
                (data as { code?: string; message?: string })?.message ??
                (data as { detail?: string })?.detail ??
                data,
            });
          } catch (err) {
            return json({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
      { names: ["skill_publish"] },
    );

    // ── skill_publish_verify ──
    api.registerTool(
      {
        name: "skill_publish_verify",
        label: "Verify skill publish result",
        description:
          "Check publish and backtest status by submissionId or backtestTaskId. Returns full backtest report when completed. Poll this until backtestStatus is completed, failed, or rejected.",
        parameters: Type.Object({
          submissionId: Type.Optional(
            Type.String({
              description: "Submission ID from skill_publish response (entry_versions.id)",
            }),
          ),
          backtestTaskId: Type.Optional(
            Type.String({
              description: "Backtest task ID from skill_publish response",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const submissionId = String(params.submissionId ?? "").trim() || undefined;
            const backtestTaskId = String(params.backtestTaskId ?? "").trim() || undefined;

            if (!submissionId && !backtestTaskId) {
              return json({
                success: false,
                error: "Either submissionId or backtestTaskId is required",
              });
            }

            if (!config.apiKey) {
              return json({
                success: false,
                error:
                  "API key not configured. Set skillApiKey in plugin config or SKILL_API_KEY env.",
              });
            }

            const searchParams: Record<string, string> = {};
            if (submissionId) searchParams.submissionId = submissionId;
            if (backtestTaskId) searchParams.backtestTaskId = backtestTaskId;

            const { status, data } = await skillApiRequest(config, "GET", "/skill/publish/verify", {
              searchParams,
            });

            if (status >= 200 && status < 300) {
              const resp = data as {
                submissionId?: string | null;
                entryId?: string | null;
                slug?: string | null;
                version?: string | null;
                strategyUploaded?: boolean;
                backtestTaskId?: string | null;
                backtestStatus?: string | null;
                backtestCompleted?: boolean;
                backtestReportInDb?: boolean;
                backtestReport?: {
                  alpha?: number | null;
                  task_id?: string;
                  metadata?: {
                    id?: string;
                    name?: string;
                    tags?: string[];
                    type?: string;
                    style?: string;
                    author?: { name?: string };
                    market?: string;
                    license?: string;
                    summary?: string;
                    version?: string;
                    archetype?: string;
                    frequency?: string;
                    riskLevel?: string;
                    visibility?: string;
                    description?: string;
                    assetClasses?: string[];
                    parameters?: Array<{
                      name: string;
                      type: string;
                      label?: string;
                      default?: unknown;
                      range?: { min?: number; max?: number; step?: number };
                    }>;
                  };
                  integrity?: {
                    fepHash?: string;
                    codeHash?: string;
                    contentCID?: string;
                    contentHash?: string;
                    publishedAt?: string;
                    timestampProof?: string;
                  };
                  performance?: {
                    hints?: string[];
                    calmar?: number;
                    sharpe?: number;
                    sortino?: number;
                    winRate?: number;
                    finalEquity?: number;
                    maxDrawdown?: number;
                    totalReturn?: number;
                    totalTrades?: number;
                    profitFactor?: number | null;
                    maxDrawdownStart?: string;
                    maxDrawdownEnd?: string;
                    monthlyReturns?:
                      | Record<string, number>
                      | Array<{ month: string; return: number }>;
                    annualizedReturn?: number;
                    returnsVolatility?: number;
                    riskReturnRatio?: number;
                    expectancy?: number;
                    avgWinner?: number;
                    avgLoser?: number;
                    maxWinner?: number;
                    maxLoser?: number;
                    longRatio?: number;
                    pnlTotal?: number;
                    startingBalance?: number;
                    endingBalance?: number;
                    backtestStart?: string;
                    backtestEnd?: string;
                    totalOrders?: number;
                    recentValidation?: {
                      decay?: {
                        sharpeDecay30d?: number;
                        sharpeDecay90d?: number;
                        warning?: string;
                      };
                      recent?: Array<{
                        period?: string;
                        window?: string;
                        sharpe?: number;
                        finalEquity?: number;
                        maxDrawdown?: number;
                        totalReturn?: number;
                        totalTrades?: number;
                      }>;
                      historical?: {
                        period?: string;
                        sharpe?: number;
                        finalEquity?: number;
                        maxDrawdown?: number;
                        totalReturn?: number;
                        totalTrades?: number;
                      };
                    };
                  };
                  equityCurve?: Array<{ date: string; equity: number }>;
                  drawdownCurve?: Array<{ date: string; drawdown: number }>;
                  trades?: Array<{
                    open_date: string;
                    close_date: string;
                    side: string;
                    quantity: number;
                    avg_open: number;
                    avg_close: number;
                    realized_pnl: string;
                    return_pct: number;
                  }>;
                  equity_curve?: unknown;
                  trade_journal?: unknown;
                };
              };

              const lines: string[] = [];
              lines.push("发布验证结果：");
              lines.push("");
              lines.push(`- Slug: ${resp.slug ?? "(未知)"}`);
              lines.push(`- Version: ${resp.version ?? "(未知)"}`);
              lines.push(`- Strategy Uploaded: ${resp.strategyUploaded ? "是" : "否"}`);
              lines.push("");
              lines.push(`- Backtest Task ID: ${resp.backtestTaskId ?? "(无)"}`);
              lines.push(`- Backtest Status: ${resp.backtestStatus ?? "(未知)"}`);
              lines.push(`- Backtest Completed: ${resp.backtestCompleted ? "是" : "否"}`);
              lines.push(`- Report in DB: ${resp.backtestReportInDb ? "是" : "否"}`);

              if (resp.backtestStatus === "completed" && resp.backtestReport?.performance) {
                const perf = resp.backtestReport.performance;
                const report = resp.backtestReport;
                lines.push("");
                lines.push("回测报告摘要：");

                // ── 收益指标 ──
                if (typeof perf.totalReturn === "number") {
                  lines.push(`- 总收益率: ${(perf.totalReturn * 100).toFixed(2)}%`);
                }
                if (typeof perf.annualizedReturn === "number") {
                  lines.push(`- 年化收益: ${(perf.annualizedReturn * 100).toFixed(2)}%`);
                }
                if (typeof perf.pnlTotal === "number") {
                  lines.push(`- 总盈亏: ${perf.pnlTotal.toFixed(2)}`);
                }

                // ── 风险指标 ──
                if (typeof perf.sharpe === "number") {
                  lines.push(`- 夏普比率: ${perf.sharpe.toFixed(3)}`);
                }
                if (typeof perf.sortino === "number") {
                  lines.push(`- 索提诺比率: ${perf.sortino.toFixed(3)}`);
                }
                if (typeof perf.calmar === "number") {
                  lines.push(`- 卡玛比率: ${perf.calmar.toFixed(3)}`);
                }
                if (typeof perf.maxDrawdown === "number") {
                  lines.push(`- 最大回撤: ${(perf.maxDrawdown * 100).toFixed(2)}%`);
                }
                if (typeof perf.returnsVolatility === "number") {
                  lines.push(`- 收益波动率: ${(perf.returnsVolatility * 100).toFixed(2)}%`);
                }
                if (typeof perf.riskReturnRatio === "number") {
                  lines.push(`- 风险回报比: ${perf.riskReturnRatio.toFixed(3)}`);
                }

                // ── 交易指标 ──
                if (typeof perf.winRate === "number") {
                  lines.push(`- 胜率: ${perf.winRate.toFixed(1)}%`);
                }
                if (typeof perf.profitFactor === "number") {
                  lines.push(`- 盈亏比: ${perf.profitFactor.toFixed(2)}`);
                }
                if (typeof perf.expectancy === "number") {
                  lines.push(`- 期望收益: ${perf.expectancy.toFixed(2)}`);
                }
                if (typeof perf.avgWinner === "number") {
                  lines.push(`- 平均盈利: ${perf.avgWinner.toFixed(2)}`);
                }
                if (typeof perf.avgLoser === "number") {
                  lines.push(`- 平均亏损: ${perf.avgLoser.toFixed(2)}`);
                }
                if (typeof perf.longRatio === "number") {
                  lines.push(`- 多头占比: ${(perf.longRatio * 100).toFixed(1)}%`);
                }

                // ── 交易统计 ──
                if (typeof perf.totalTrades === "number") {
                  lines.push(`- 交易笔数: ${perf.totalTrades}`);
                }
                if (typeof perf.totalOrders === "number") {
                  lines.push(`- 总订单数: ${perf.totalOrders}`);
                }

                // ── 资金信息 ──
                if (typeof perf.startingBalance === "number") {
                  lines.push(`- 初始资金: ${perf.startingBalance.toFixed(2)}`);
                }
                if (typeof perf.endingBalance === "number") {
                  lines.push(`- 最终资金: ${perf.endingBalance.toFixed(2)}`);
                }
                if (typeof perf.finalEquity === "number") {
                  lines.push(`- 期末权益: ${perf.finalEquity.toFixed(2)}`);
                }

                // ── 回测周期 ──
                if (perf.backtestStart || perf.backtestEnd) {
                  lines.push(
                    `- 回测周期: ${perf.backtestStart ?? "?"} ~ ${perf.backtestEnd ?? "?"}`,
                  );
                }

                // ── 时序数据统计 ──
                if (report.equityCurve && Array.isArray(report.equityCurve)) {
                  lines.push(`- 权益曲线点数: ${report.equityCurve.length}`);
                }
                if (report.drawdownCurve && Array.isArray(report.drawdownCurve)) {
                  lines.push(`- 回撤曲线点数: ${report.drawdownCurve.length}`);
                }
                if (report.trades && Array.isArray(report.trades)) {
                  lines.push(`- 交易记录数: ${report.trades.length}`);
                }

                // ── 提示 ──
                if (perf.hints && perf.hints.length > 0) {
                  lines.push("");
                  lines.push("提示:");
                  for (const hint of perf.hints) {
                    lines.push(`- ${hint}`);
                  }
                }
                if (perf.recentValidation?.decay?.warning) {
                  lines.push("");
                  lines.push(`⚠️ 衰减警告: ${perf.recentValidation.decay.warning}`);
                }
              } else if (resp.backtestStatus === "failed" || resp.backtestStatus === "rejected") {
                lines.push("");
                lines.push(
                  `回测${resp.backtestStatus === "failed" ? "失败" : "被拒绝"}，请检查策略代码。`,
                );
              } else if (
                resp.backtestStatus === "submitted" ||
                resp.backtestStatus === "queued" ||
                resp.backtestStatus === "processing"
              ) {
                lines.push("");
                lines.push("回测进行中，请稍后再次查询...");
              }

              return {
                content: [{ type: "text" as const, text: lines.join("\n") }],
                details: { success: true, ...resp },
              };
            }

            return json({
              success: false,
              status,
              error:
                (data as { code?: string; message?: string })?.message ??
                (data as { detail?: string })?.detail ??
                data,
            });
          } catch (err) {
            return json({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
      { names: ["skill_publish_verify"] },
    );

    // ── skill_validate ──
    api.registerTool(
      {
        name: "skill_validate",
        label: "Validate strategy package (FEP v2.0)",
        description:
          "Validate a strategy package directory per FEP v2.0 before zipping and publishing. " +
          "Checks: fep.yaml with identity (id, name, type, version, style, visibility, summary, description, license, author, changelog, tags), " +
          "backtest (symbol, defaultPeriod, initialCapital); scripts/strategy.py with compute(data) or select(universe) and no forbidden imports. " +
          "Only publish after validation passes.",
        parameters: Type.Object({
          dirPath: Type.String({
            description:
              "Path to strategy package directory (must contain fep.yaml and scripts/strategy.py)",
          }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const dirPath = String(params.dirPath ?? "").trim();
            if (!dirPath) {
              return json({ success: false, valid: false, errors: ["dirPath is required"] });
            }
            const resolved = api.resolvePath(dirPath);
            const result = await validateStrategyPackage(resolved);
            return json({
              success: result.valid,
              valid: result.valid,
              errors: result.errors,
              warnings: result.warnings,
            });
          } catch (err) {
            return json({
              success: false,
              valid: false,
              errors: [err instanceof Error ? err.message : String(err)],
            });
          }
        },
      },
      { names: ["skill_validate"] },
    );

    // ── skill_leaderboard ──
    api.registerTool(
      {
        name: "skill_leaderboard",
        label: "Get Hub leaderboard",
        description:
          "Query strategy leaderboard from hub.openfinclaw.ai. No API key required. Board types: composite (default, FCS score), returns (profit), risk (risk control), popular (subscribers), rising (new strategies). Use this to discover top strategies before using skill_get_info or skill_fork.",
        parameters: Type.Object({
          boardType: Type.Optional(
            Type.Unsafe<BoardType>({
              type: "string",
              enum: ["composite", "returns", "risk", "popular", "rising"],
              description:
                "Leaderboard type: composite (default, FCS score), returns (profit), risk (risk control), popular (subscribers), rising (new strategies within 30 days)",
            }),
          ),
          limit: Type.Optional(
            Type.Number({
              description: "Number of results (max 100, default 20)",
              minimum: 1,
              maximum: 100,
            }),
          ),
          offset: Type.Optional(
            Type.Number({
              description: "Offset for pagination (default 0)",
              minimum: 0,
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const boardType = (params.boardType as BoardType) || "composite";
            const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
            const offset = Math.max(Number(params.offset) || 0, 0);

            const url = new URL(`${config.baseUrl}/api/v1/skill/leaderboard/${boardType}`);
            url.searchParams.set("limit", String(limit));
            url.searchParams.set("offset", String(offset));

            const response = await fetch(url.toString(), {
              method: "GET",
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(config.requestTimeoutMs),
            });

            const rawText = await response.text();
            let data: unknown;

            if (rawText && rawText.trim().startsWith("{")) {
              try {
                data = JSON.parse(rawText);
              } catch {
                data = { raw: rawText };
              }
            }

            if (response.status < 200 || response.status >= 300) {
              const errorData = data as { error?: { message?: string }; message?: string };
              return json({
                success: false,
                error: errorData.error?.message ?? errorData.message ?? `HTTP ${response.status}`,
              });
            }

            const leaderboard = data as LeaderboardResponse;
            const boardNames: Record<string, string> = {
              composite: "综合榜",
              returns: "收益榜",
              risk: "风控榜",
              popular: "人气榜",
              rising: "新星榜",
            };

            const lines: string[] = [];
            lines.push(
              `${boardNames[boardType] || boardType} Top ${leaderboard.strategies.length} (共 ${leaderboard.total} 个策略):`,
            );
            lines.push("");

            for (const s of leaderboard.strategies) {
              const perf = s.performance || {};
              const returnStr =
                typeof perf.returnSincePublish === "number"
                  ? `收益: ${(perf.returnSincePublish * 100).toFixed(1)}%`
                  : "收益: --";
              const sharpeStr =
                typeof perf.sharpeRatio === "number"
                  ? `夏普: ${perf.sharpeRatio.toFixed(2)}`
                  : "夏普: --";
              const ddStr =
                typeof perf.maxDrawdown === "number"
                  ? `回撤: ${(perf.maxDrawdown * 100).toFixed(1)}%`
                  : "回撤: --";
              const author = s.author?.displayName || "未知";

              const truncatedName = s.name.length > 35 ? s.name.slice(0, 32) + "..." : s.name;
              const hubUrl = `https://hub.openfinclaw.ai/strategy/${s.id}`;
              const nameLink = `[${truncatedName}](${hubUrl})`;
              lines.push(
                `#${String(s.rank).padStart(2)}  ${nameLink}  ${returnStr}  ${sharpeStr}  ${ddStr}  作者: ${author}`,
              );
            }

            lines.push("");
            lines.push("使用 skill_get_info <id> 查看策略详情");
            lines.push("使用 skill_fork <id> 下载策略到本地（需要 API Key）");

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: { success: true, ...leaderboard },
            };
          } catch (err) {
            return json({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
      { names: ["skill_leaderboard"] },
    );

    // ── skill_fork ──
    api.registerTool(
      {
        name: "skill_fork",
        label: "Fork strategy from Hub",
        description:
          "Fork a public strategy from hub.openfinclaw.ai to local directory. Creates a new entry on Hub and downloads the code locally. Returns the local path and fork entry ID. Use this when user wants to download, clone, or fork a strategy from Hub. Requires API key.",
        parameters: Type.Object({
          strategyId: Type.String({
            description:
              "Strategy ID from Hub (UUID or Hub URL like https://hub.openfinclaw.ai/strategy/{id})",
          }),
          name: Type.Optional(
            Type.String({
              description: "Name for the forked strategy. Default: original name + '(Fork)'",
            }),
          ),
          slug: Type.Optional(
            Type.String({
              description:
                "URL-friendly slug for the forked strategy. Auto-generated if not provided.",
            }),
          ),
          keepGenes: Type.Optional(
            Type.Boolean({
              description: "Whether to inherit gene combinations. Default: true",
            }),
          ),
          targetDir: Type.Optional(
            Type.String({
              description:
                "Custom target directory. Default: ~/.openfinclaw/workspace/strategies/{date}/{name}-{shortId}/",
            }),
          ),
          dateDir: Type.Optional(
            Type.String({
              description: "Date directory (YYYY-MM-DD). Default: today",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const strategyId = String(params.strategyId ?? "").trim();
            if (!strategyId) {
              return json({ success: false, error: "strategyId is required" });
            }

            if (!config.apiKey) {
              return json({
                success: false,
                error:
                  "API key is required for fork operation. Set skillApiKey in plugin config or SKILL_API_KEY env.",
              });
            }

            const result = await forkStrategy(config, strategyId, {
              name: params.name ? String(params.name) : undefined,
              slug: params.slug ? String(params.slug) : undefined,
              keepGenes: typeof params.keepGenes === "boolean" ? params.keepGenes : undefined,
              targetDir: params.targetDir ? String(params.targetDir) : undefined,
              dateDir: params.dateDir ? String(params.dateDir) : undefined,
            });

            if (result.success) {
              const lines: string[] = [];
              lines.push("策略 Fork 成功！");
              lines.push("");
              lines.push(`- 原策略: ${result.sourceName} (${result.sourceId})`);
              lines.push(`- Fork Entry ID: ${result.forkEntryId}`);
              if (result.forkEntrySlug) {
                lines.push(`- Fork Slug: ${result.forkEntrySlug}`);
              }
              lines.push(`- 本地路径: ${result.localPath}`);

              if (result.creditsEarned) {
                lines.push("");
                lines.push("积分奖励:");
                lines.push(`- 获得 ${result.creditsEarned.amount} FC`);
                if (result.creditsEarned.message) {
                  lines.push(`- ${result.creditsEarned.message}`);
                }
              }

              lines.push("");
              lines.push("下一步:");
              lines.push(`- 编辑策略: code ${result.localPath}/scripts/strategy.py`);
              lines.push(`- 验证修改: openfinclaw strategy validate ${result.localPath}`);
              lines.push(`- 发布新版本: openfinclaw strategy publish ${result.localPath}`);

              return {
                content: [{ type: "text" as const, text: lines.join("\n") }],
                details: result,
              };
            }

            return json({
              success: false,
              error: result.error ?? "Failed to fork strategy",
            });
          } catch (err) {
            return json({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
      { names: ["skill_fork"] },
    );

    // ── skill_list_local ──
    api.registerTool(
      {
        name: "skill_list_local",
        label: "List local strategies",
        description:
          "List all strategies downloaded or created locally, organized by date. Shows strategy name, type (forked/created), and local path.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const strategies = await listLocalStrategies();

            if (strategies.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "本地暂无策略。\n\n使用 skill_fork 从 Hub 下载策略，或使用 skill_validate 验证本地策略目录。",
                  },
                ],
                details: { success: true, strategies: [] },
              };
            }

            const lines: string[] = [];
            lines.push(`本地策略列表 (共 ${strategies.length} 个):`);
            lines.push("");

            let currentDate = "";
            for (const s of strategies) {
              if (s.dateDir !== currentDate) {
                currentDate = s.dateDir;
                lines.push(`${s.dateDir}/`);
              }
              const typeLabel = s.type === "forked" ? "(forked)" : "(created)";
              lines.push(
                `  ${s.name.padEnd(40)} ${s.displayName.slice(0, 20).padEnd(20)} ${typeLabel}`,
              );
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: { success: true, strategies },
            };
          } catch (err) {
            return json({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
      { names: ["skill_list_local"] },
    );

    // ── skill_get_info ──
    api.registerTool(
      {
        name: "skill_get_info",
        label: "Get strategy info from Hub",
        description:
          "Fetch detailed information about a strategy from hub.openfinclaw.ai. No API key required for public strategies. Returns performance metrics (return, sharpe, max drawdown, win rate). Use this before forking to preview the strategy.",
        parameters: Type.Object({
          strategyId: Type.String({
            description:
              "Strategy ID from Hub (UUID or Hub URL like https://hub.openfinclaw.ai/strategy/{id})",
          }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const strategyId = String(params.strategyId ?? "").trim();
            if (!strategyId) {
              return json({ success: false, error: "strategyId is required" });
            }

            const result = await fetchStrategyInfo(config, strategyId);

            if (result.success && result.data) {
              const info = result.data;
              const lines: string[] = [];
              lines.push("策略信息:");
              lines.push("");
              lines.push(`- ID: ${info.id}`);
              lines.push(`- 名称: ${info.name}`);
              if (info.slug) lines.push(`- Slug: ${info.slug}`);
              if (info.version) lines.push(`- 版本: ${info.version}`);
              if (info.author?.displayName) lines.push(`- 作者: ${info.author.displayName}`);
              if (info.description) lines.push(`- 描述: ${info.description}`);
              if (info.summary) lines.push(`- 摘要: ${info.summary}`);
              if (info.tags?.length) lines.push(`- 标签: ${info.tags.join(", ")}`);
              if (info.tier) lines.push(`- 等级: ${info.tier}`);

              if (info.stats) {
                lines.push("");
                lines.push("统计:");
                if (typeof info.stats.fcsScore === "number") {
                  lines.push(`- FCS 评分: ${info.stats.fcsScore.toFixed(1)}`);
                }
                if (typeof info.stats.forkCount === "number") {
                  lines.push(`- Fork 次数: ${info.stats.forkCount}`);
                }
                if (typeof info.stats.downloadCount === "number") {
                  lines.push(`- 下载次数: ${info.stats.downloadCount}`);
                }
              }

              if (info.backtestResult) {
                lines.push("");
                lines.push("绩效指标:");
                const perf = info.backtestResult;
                if (typeof perf.totalReturn === "number") {
                  lines.push(`- 总收益率: ${(perf.totalReturn * 100).toFixed(2)}%`);
                }
                if (typeof perf.sharpe === "number") {
                  lines.push(`- 夏普比率: ${perf.sharpe.toFixed(3)}`);
                }
                if (typeof perf.maxDrawdown === "number") {
                  lines.push(`- 最大回撤: ${(perf.maxDrawdown * 100).toFixed(2)}%`);
                }
                if (typeof perf.winRate === "number") {
                  lines.push(`- 胜率: ${(perf.winRate * 100).toFixed(1)}%`);
                }
              }

              lines.push("");
              lines.push(`Hub URL: https://hub.openfinclaw.ai/strategy/${info.id}`);
              lines.push("");
              lines.push("使用 skill_fork 下载此策略到本地。");

              return {
                content: [{ type: "text" as const, text: lines.join("\n") }],
                details: { success: true, ...info },
              };
            }

            return json({
              success: false,
              error: result.error ?? "Failed to fetch strategy info",
            });
          } catch (err) {
            return json({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
      { names: ["skill_get_info"] },
    );

    // ── CLI commands ──
    api.registerCli(
      ({ program }) =>
        registerStrategyCli({
          program,
          config,
          logger: api.logger,
        }),
      { commands: ["strategy"] },
    );
  },
};

export default openfinclawPlugin;
