/**
 * fin-backtest-remote — OpenFinClaw plugin for the remote Findoo Backtest Agent (fep v1.1).
 * Registers tools: submit, status, report, list, cancel, validate (strategy package).
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

/** Resolved plugin config for remote backtest API. */
type BacktestRemoteConfig = {
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
 * Resolve config from plugin config and env (BACKTEST_API_KEY per API doc).
 */
function resolveConfig(api: OpenClawPluginApi): BacktestRemoteConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;
  const baseUrl =
    (typeof raw?.baseUrl === "string" ? raw.baseUrl : undefined) ??
    readEnv(["BACKTEST_API_BASE_URL", "BACKTEST_BASE_URL"]) ??
    "http://150.109.16.195:8000";
  const apiKey =
    (typeof raw?.apiKey === "string" ? raw.apiKey : undefined) ?? readEnv(["BACKTEST_API_KEY"]);
  const timeoutRaw = raw?.requestTimeoutMs ?? readEnv(["BACKTEST_REQUEST_TIMEOUT_MS"]);
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
 * GET/POST/DELETE with optional X-API-Key. Base path is /api/v1.
 */
async function backtestRequest(
  config: BacktestRemoteConfig,
  method: "GET" | "POST" | "DELETE",
  pathSegments: string,
  options?: { body?: FormData | Record<string, unknown>; searchParams?: Record<string, string> },
): Promise<{ status: number; data: unknown }> {
  const url = new URL(`${config.baseUrl}/api/v1${pathSegments}`);
  if (options?.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  }

  let body: BodyInit | undefined;
  if (options?.body) {
    if (options.body instanceof FormData) {
      body = options.body;
      // Do not set Content-Type; fetch sets multipart boundary
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const raw = await response.text();
  let data: unknown = raw;
  if (raw && raw.trim().startsWith("{")) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  return { status: response.status, data };
}

const finBacktestRemotePlugin = {
  id: "fin-backtest-remote",
  name: "Backtest Remote",
  description:
    "Submit and manage backtests on the remote Findoo Backtest Agent (fep v1.1). Use when the user wants to run a strategy backtest, check status, or fetch reports.",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);

    // ── backtest_remote_submit ──
    api.registerTool(
      {
        name: "backtest_remote_submit",
        label: "Submit remote backtest",
        description:
          "Submit a strategy ZIP to the remote backtest server. Requires a local path to a ZIP file (must contain fep.yaml and scripts/strategy.py). Optional overrides: symbol, initial_capital, start_date, end_date, engine (script|agent), budget_cap_usd.",
        parameters: Type.Object({
          filePath: Type.String({
            description: "Absolute or workspace-relative path to the strategy ZIP file",
          }),
          symbol: Type.Optional(
            Type.String({ description: "Trading symbol override, e.g. BTC-USD, ETH-USD" }),
          ),
          initial_capital: Type.Optional(Type.Number({ description: "Initial capital override" })),
          start_date: Type.Optional(Type.String({ description: "Start date YYYY-MM-DD" })),
          end_date: Type.Optional(Type.String({ description: "End date YYYY-MM-DD" })),
          engine: Type.Optional(
            Type.Unsafe<"script" | "agent">({
              type: "string",
              enum: ["script", "agent"],
              description: "script (L1) or agent (L2)",
            }),
          ),
          budget_cap_usd: Type.Optional(Type.Number({ description: "L2 Agent budget cap in USD" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const filePath = String(params.filePath ?? "").trim();
            if (!filePath) {
              return json({ success: false, error: "filePath is required" });
            }
            const resolvedPath = api.resolvePath(filePath);
            const buf = await readFile(resolvedPath);
            const form = new FormData();
            form.append("file", new Blob([buf]), path.basename(resolvedPath));
            if (typeof params.symbol === "string" && params.symbol.trim()) {
              form.append("symbol", params.symbol.trim());
            }
            if (typeof params.initial_capital === "number") {
              form.append("initial_capital", String(params.initial_capital));
            }
            if (typeof params.start_date === "string" && params.start_date.trim()) {
              form.append("start_date", params.start_date.trim());
            }
            if (typeof params.end_date === "string" && params.end_date.trim()) {
              form.append("end_date", params.end_date.trim());
            }
            if (params.engine === "script" || params.engine === "agent") {
              form.append("engine", params.engine);
            }
            if (typeof params.budget_cap_usd === "number") {
              form.append("budget_cap_usd", String(params.budget_cap_usd));
            }

            const { status, data } = await backtestRequest(config, "POST", "/backtests", {
              body: form,
            });
            if (status >= 200 && status < 300) {
              return json({ success: true, ...(data as object) });
            }
            return json({
              success: false,
              status,
              error:
                (data as { message?: string; detail?: string })?.message ??
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
      { names: ["backtest_remote_submit"] },
    );

    // ── backtest_remote_status ──
    api.registerTool(
      {
        name: "backtest_remote_status",
        label: "Get remote backtest status",
        description:
          "Get status and result summary for a backtest task. Poll until status is completed, failed, or rejected.",
        parameters: Type.Object({
          task_id: Type.String({
            description: "Task ID returned from submit (e.g. bt-a1b2c3d4e5f6)",
          }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const taskId = String(params.task_id ?? "").trim();
            if (!taskId) {
              return json({ success: false, error: "task_id is required" });
            }
            const { status, data } = await backtestRequest(
              config,
              "GET",
              `/backtests/${encodeURIComponent(taskId)}`,
            );
            if (status >= 200 && status < 300) {
              return json({ success: true, ...(data as object) });
            }
            return json({
              success: false,
              status,
              error:
                (data as { message?: string; detail?: string })?.message ??
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
      { names: ["backtest_remote_status"] },
    );

    // ── backtest_remote_report ──
    api.registerTool(
      {
        name: "backtest_remote_report",
        label: "Get remote backtest report",
        description:
          "Get full report for a completed backtest (metadata, performance, equity_curve, trade_journal). Only available when status is completed.",
        parameters: Type.Object({
          task_id: Type.String({
            description: "Task ID from submit (e.g. bt-a1b2c3d4e5f6)",
          }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const taskId = String(params.task_id ?? "").trim();
            if (!taskId) {
              return json({ success: false, error: "task_id is required" });
            }
            const { status, data } = await backtestRequest(
              config,
              "GET",
              `/backtests/${encodeURIComponent(taskId)}/report`,
            );
            if (status >= 200 && status < 300) {
              const report = data as {
                metadata?: {
                  name?: string;
                  id?: string;
                  style?: string;
                  market?: string;
                  riskLevel?: string;
                  tags?: string[];
                };
                performance?: {
                  totalReturn?: number;
                  annualizedReturn?: number;
                  sharpe?: number;
                  sortino?: number;
                  calmar?: number;
                  maxDrawdown?: number;
                  winRate?: number;
                  profitFactor?: number | null;
                  totalTrades?: number;
                  finalEquity?: number;
                  monthlyReturns?: Record<string, number>;
                };
              };

              const lines: string[] = [];
              const meta = report.metadata ?? {};
              const perf = report.performance ?? {};

              lines.push("远程回测已完成，以下是简要报告：");
              lines.push("");
              lines.push(`- 策略名称: ${meta.name ?? "(未知)"}`);
              lines.push(`- 策略 ID : ${meta.id ?? "(未知)"}`);
              if (meta.style) {
                lines.push(`- 策略风格: ${meta.style}`);
              }
              if (meta.market) {
                lines.push(`- 市场类型: ${meta.market}`);
              }
              if (meta.riskLevel) {
                lines.push(`- 风险等级: ${meta.riskLevel}`);
              }
              if (Array.isArray(meta.tags) && meta.tags.length > 0) {
                lines.push(`- 标签: ${meta.tags.join(", ")}`);
              }
              lines.push("");
              if (
                typeof perf.totalReturn === "number" ||
                typeof perf.annualizedReturn === "number" ||
                typeof perf.sharpe === "number" ||
                typeof perf.sortino === "number" ||
                typeof perf.calmar === "number" ||
                typeof perf.maxDrawdown === "number" ||
                typeof perf.winRate === "number" ||
                typeof perf.totalTrades === "number" ||
                typeof perf.finalEquity === "number"
              ) {
                lines.push("核心表现指标：");
                if (typeof perf.totalReturn === "number") {
                  lines.push(`- 总收益率: ${(perf.totalReturn * 100).toFixed(2)}%`);
                }
                if (typeof perf.annualizedReturn === "number") {
                  lines.push(`- 年化收益率: ${(perf.annualizedReturn * 100).toFixed(2)}%`);
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
                  lines.push(`- 盈亏比(Profit Factor): ${perf.profitFactor.toFixed(2)}`);
                }
                if (typeof perf.totalTrades === "number") {
                  lines.push(`- 交易笔数: ${perf.totalTrades}`);
                }
                if (typeof perf.finalEquity === "number") {
                  lines.push(`- 期末权益: ${perf.finalEquity.toFixed(2)}`);
                }
              } else {
                lines.push("（报告中未包含标准 performance 字段，请查看原始 JSON 详情。）");
              }
              lines.push("");
              lines.push("完整原始报告如下（供高级分析使用）：");

              const summaryText = `${lines.join("\n")}\n\n${JSON.stringify(data, null, 2)}`;

              return {
                content: [{ type: "text" as const, text: summaryText }],
                details: { success: true, ...(data as object) },
              };
            }
            return json({
              success: false,
              status,
              error:
                (data as { message?: string; detail?: string })?.message ??
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
      { names: ["backtest_remote_report"] },
    );

    // ── backtest_remote_list ──
    api.registerTool(
      {
        name: "backtest_remote_list",
        label: "List remote backtest tasks",
        description: "List backtest tasks with optional limit and offset.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "Max items per page (default 20)" })),
          offset: Type.Optional(Type.Number({ description: "Offset for pagination (default 0)" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const searchParams: Record<string, string> = {};
            if (typeof params.limit === "number" && params.limit > 0) {
              searchParams.limit = String(params.limit);
            }
            if (typeof params.offset === "number" && params.offset >= 0) {
              searchParams.offset = String(params.offset);
            }
            const { status, data } = await backtestRequest(config, "GET", "/backtests", {
              searchParams: Object.keys(searchParams).length > 0 ? searchParams : undefined,
            });
            if (status >= 200 && status < 300) {
              return json({ success: true, ...(data as object) });
            }
            return json({
              success: false,
              status,
              error:
                (data as { message?: string; detail?: string })?.message ??
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
      { names: ["backtest_remote_list"] },
    );

    // ── backtest_remote_cancel ──
    api.registerTool(
      {
        name: "backtest_remote_cancel",
        label: "Cancel remote backtest task",
        description: "Cancel a queued backtest task. Only queued tasks can be cancelled.",
        parameters: Type.Object({
          task_id: Type.String({
            description: "Task ID to cancel (e.g. bt-a1b2c3d4e5f6)",
          }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const taskId = String(params.task_id ?? "").trim();
            if (!taskId) {
              return json({ success: false, error: "task_id is required" });
            }
            const { status, data } = await backtestRequest(
              config,
              "DELETE",
              `/backtests/${encodeURIComponent(taskId)}`,
            );
            if (status >= 200 && status < 300) {
              return json({ success: true, ...(data as object) });
            }
            return json({
              success: false,
              status,
              error:
                (data as { message?: string; detail?: string })?.message ??
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
      { names: ["backtest_remote_cancel"] },
    );

    // ── backtest_remote_validate ──
    api.registerTool(
      {
        name: "backtest_remote_validate",
        label: "Validate strategy package",
        description:
          "Validate a strategy package directory (fep v1.1) before zipping and submitting. Checks: fep.yaml with identity/technical/backtest, scripts/strategy.py with compute(data), and no forbidden imports (os, subprocess, eval, exec, open, requests, urllib). Only upload after validation passes.",
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
      { names: ["backtest_remote_validate"] },
    );
  },
};

export default finBacktestRemotePlugin;
