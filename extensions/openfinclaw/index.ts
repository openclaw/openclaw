/**
 * OpenFinClaw — Skill publishing and strategy validation tools.
 * Tools: skill_publish, skill_publish_verify, skill_validate.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
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
    "Skill publishing and strategy validation tools. Publish strategy ZIPs to remote server with automatic backtest.",

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
                    monthlyReturns?: Record<string, number>;
                    annualizedReturn?: number;
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
                lines.push("");
                lines.push("回测报告摘要：");
                if (typeof perf.totalReturn === "number") {
                  lines.push(`- 总收益率: ${(perf.totalReturn * 100).toFixed(2)}%`);
                }
                if (typeof perf.annualizedReturn === "number") {
                  lines.push(`- 年化收益: ${(perf.annualizedReturn * 100).toFixed(2)}%`);
                }
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
                if (typeof perf.winRate === "number") {
                  lines.push(`- 胜率: ${perf.winRate.toFixed(1)}%`);
                }
                if (typeof perf.profitFactor === "number") {
                  lines.push(`- 盈亏比: ${perf.profitFactor.toFixed(2)}`);
                }
                if (typeof perf.totalTrades === "number") {
                  lines.push(`- 交易笔数: ${perf.totalTrades}`);
                }
                if (typeof perf.finalEquity === "number") {
                  lines.push(`- 期末权益: ${perf.finalEquity.toFixed(2)}`);
                }
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
        label: "Validate strategy package",
        description:
          "Validate a strategy package directory (fep v1.2) before zipping and publishing. Checks: fep.yaml with identity (id, name, type, version, style, visibility, summary, license, author, changelog), classification, technical, backtest; scripts/strategy.py with compute(data) and no forbidden imports. Only publish after validation passes.",
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
  },
};

export default openfinclawPlugin;
