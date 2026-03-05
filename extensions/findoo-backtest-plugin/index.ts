import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { BacktestClient } from "./src/backtest-client.js";
import { resolveConfig } from "./src/config.js";
import { pollUntilDone } from "./src/poller.js";
import { toBacktestResult } from "./src/result-mapper.js";
import { packStrategy } from "./src/strategy-packer.js";
import { validateStrategy } from "./src/strategy-validator.js";
import type { RemoteReport, SubmitResponse, UploadParams } from "./src/types.js";

/* ---------- helpers ---------- */

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

function formatSummary(r: RemoteReport): Record<string, unknown> {
  const p = r.performance;
  return {
    task_id: r.task_id,
    total_return: p?.totalReturn != null ? `${p.totalReturn.toFixed(2)}%` : "N/A",
    sharpe: p?.sharpe?.toFixed(3) ?? "N/A",
    max_drawdown: p?.maxDrawdown != null ? `${p.maxDrawdown.toFixed(2)}%` : "N/A",
    total_trades: p?.totalTrades ?? 0,
    ...(p?.sortino != null ? { sortino: p.sortino.toFixed(3) } : {}),
    ...(p?.calmar != null ? { calmar: p.calmar.toFixed(3) } : {}),
    ...(p?.winRate != null ? { win_rate: `${(p.winRate * 100).toFixed(1)}%` } : {}),
    ...(p?.profitFactor != null ? { profit_factor: p.profitFactor.toFixed(2) } : {}),
    ...(p?.finalEquity != null ? { final_equity: p.finalEquity.toFixed(2) } : {}),
    ...(p?.annualizedReturn != null
      ? { annualized_return: `${p.annualizedReturn.toFixed(2)}%` }
      : {}),
  };
}

/* ---------- plugin ---------- */

const findooBacktestPlugin = {
  id: "findoo-backtest-plugin",
  name: "Findoo Backtest",
  description:
    "Remote backtesting via Findoo Backtest Agent (FEP v1.1) — " +
    "L1 (script deterministic) and L2 (Agent+LLM intelligent) engines.",
  kind: "financial" as const,

  async register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);
    const client = new BacktestClient(
      config.backtestApiUrl,
      config.backtestApiKey,
      config.requestTimeoutMs,
    );

    // ------------------------------------------------------------------
    // Service: fin-remote-backtest
    // ------------------------------------------------------------------

    const service = {
      async submit(archive: Buffer, filename: string, params?: UploadParams, wait = true) {
        const resp = await client.submit(archive, filename, params);
        if (!wait) return resp;
        return pollUntilDone(client, resp.task_id, {
          intervalMs: config.pollIntervalMs,
          timeoutMs: config.pollTimeoutMs,
        });
      },
      getTask: (taskId: string) => client.getTask(taskId),
      getReport: (taskId: string) => client.getReport(taskId),
      listTasks: (limit?: number, offset?: number) => client.listTasks(limit, offset),
      cancelTask: (taskId: string) => client.cancelTask(taskId),
      health: () => client.health(),
      toBacktestResult: (
        report: RemoteReport,
        meta: { strategyId: string; initialCapital: number },
      ) => toBacktestResult(report, meta),
    };

    api.registerService({
      id: "fin-remote-backtest",
      start: () => {},
      instance: service,
    } as Parameters<typeof api.registerService>[0]);

    // ==================================================================
    // AI Tools (6 total)
    // ==================================================================

    // === Tool 1: fin_backtest_remote_submit (Upload ZIP & Submit) ===
    api.registerTool(
      {
        name: "fin_backtest_remote_submit",
        label: "Remote Backtest — Upload & Submit",
        description:
          "Pack a local strategy directory into ZIP and submit to the remote Findoo Backtest Agent. " +
          "Supports L1 (script deterministic) and L2 (Agent+LLM intelligent) engines. " +
          "By default runs compliance check, then waits for completion and returns the report summary.",
        parameters: Type.Object({
          strategy_path: Type.String({
            description: "Local path to the strategy directory",
          }),
          engine: Type.Optional(
            Type.Unsafe<string>({
              type: "string",
              enum: ["script", "agent"],
              description: "Backtest engine: 'script' (L1) or 'agent' (L2). Default: 'script'",
            }),
          ),
          symbol: Type.Optional(Type.String({ description: "Trading symbol (default: BTC-USD)" })),
          initial_capital: Type.Optional(
            Type.Number({ description: "Starting capital in USD (default: 100000)" }),
          ),
          start_date: Type.Optional(
            Type.String({ description: "Backtest start date (YYYY-MM-DD)" }),
          ),
          end_date: Type.Optional(Type.String({ description: "Backtest end date (YYYY-MM-DD)" })),
          validate: Type.Optional(
            Type.Boolean({ description: "Run compliance check before upload (default: true)" }),
          ),
          wait: Type.Optional(
            Type.Boolean({ description: "Wait for completion and return report (default: true)" }),
          ),
          budget_cap_usd: Type.Optional(Type.Number({ description: "L2: Max LLM budget in USD" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const dirPath = String(params.strategy_path);
            const shouldValidate = params.validate !== false;

            // Optional pre-upload validation
            if (shouldValidate) {
              const validation = await validateStrategy(dirPath);
              if (!validation.valid) {
                return json({
                  success: false,
                  message: `Compliance check failed: ${validation.errors.length} error(s)`,
                  errors: validation.errors,
                  warnings: validation.warnings,
                });
              }
            }

            // Pack into ZIP
            const zipBuffer = await packStrategy(dirPath);
            const archiveName = `strategy-${Date.now()}.zip`;

            // Build upload params
            const uploadParams: UploadParams = {};
            if (params.engine) uploadParams.engine = params.engine as UploadParams["engine"];
            if (params.symbol) uploadParams.symbol = String(params.symbol);
            if (params.start_date) uploadParams.start_date = String(params.start_date);
            if (params.end_date) uploadParams.end_date = String(params.end_date);
            if (params.initial_capital != null)
              uploadParams.initial_capital = Number(params.initial_capital);
            if (params.budget_cap_usd != null)
              uploadParams.budget_cap_usd = Number(params.budget_cap_usd);

            // Submit (multipart upload)
            const submitResp = await client.submit(zipBuffer, archiveName, uploadParams);
            const wait = params.wait !== false;

            if (!wait) {
              return json({
                success: true,
                message: "Backtest submitted (async mode)",
                task_id: submitResp.task_id,
                status: submitResp.status,
                archive_size: zipBuffer.length,
              });
            }

            // Synchronous: poll until done
            const result = await pollUntilDone(client, submitResp.task_id, {
              intervalMs: config.pollIntervalMs,
              timeoutMs: config.pollTimeoutMs,
            });

            if (!result.report) {
              return json({
                success: true,
                task_id: submitResp.task_id,
                status: result.task.status,
                message: "Task finished but no report available",
              });
            }

            return json({
              success: true,
              ...formatSummary(result.report),
              trade_journal_count: result.report.trade_journal?.length ?? 0,
              equity_points: result.report.equity_curve?.length ?? 0,
              archive_size: zipBuffer.length,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_backtest_remote_submit"] },
    );

    // === Tool 2: fin_backtest_remote_status ===
    api.registerTool(
      {
        name: "fin_backtest_remote_status",
        label: "Remote Backtest — Status",
        description:
          "Check the status of a remote backtest task. Optionally include the full report.",
        parameters: Type.Object({
          task_id: Type.String({ description: "Backtest task ID" }),
          include_report: Type.Optional(
            Type.Boolean({ description: "Include full report if completed (default: false)" }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const taskId = String(params.task_id);
            const task = await client.getTask(taskId);

            if (params.include_report && task.status === "completed") {
              const report = await client.getReport(taskId);
              return json({
                ...task,
                report_summary: formatSummary(report),
                trade_journal_count: report.trade_journal?.length ?? 0,
              });
            }

            return json(task);
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_backtest_remote_status"] },
    );

    // === Tool 3: fin_backtest_remote_list ===
    api.registerTool(
      {
        name: "fin_backtest_remote_list",
        label: "Remote Backtest — List",
        description: "List remote backtest task history with pagination.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "Max tasks to return (default: 20)" })),
          offset: Type.Optional(Type.Number({ description: "Offset for pagination (default: 0)" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const limit = params.limit != null ? Number(params.limit) : undefined;
            const offset = params.offset != null ? Number(params.offset) : undefined;
            const result = await client.listTasks(limit, offset);
            return json({
              success: true,
              total: result.total,
              showing: result.tasks.length,
              tasks: result.tasks.map((t) => ({
                task_id: t.task_id,
                status: t.status,
                created_at: t.created_at,
                progress: t.progress,
              })),
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_backtest_remote_list"] },
    );

    // === Tool 4: fin_backtest_remote_cancel ===
    api.registerTool(
      {
        name: "fin_backtest_remote_cancel",
        label: "Remote Backtest — Cancel",
        description: "Cancel a queued or processing remote backtest task (sends DELETE).",
        parameters: Type.Object({
          task_id: Type.String({ description: "Backtest task ID to cancel" }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const taskId = String(params.task_id);
            const result = await client.cancelTask(taskId);
            return json({
              success: true,
              task_id: result.task_id,
              status: result.status,
              message: "Cancel request sent",
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_backtest_remote_cancel"] },
    );

    // === Tool 5: fin_backtest_strategy_check ===
    api.registerTool(
      {
        name: "fin_backtest_strategy_check",
        label: "Strategy — Compliance Check",
        description:
          "Validate a local strategy directory against FEP 1.0/1.1 specification. " +
          "Checks structure (fep.yaml, strategy.py), Python interface (compute(data) or Strategy class), " +
          "safety (no dangerous imports), YAML sections, and data consistency. " +
          "Run this before uploading to catch issues early.",
        parameters: Type.Object({
          strategy_path: Type.String({
            description: "Local path to the strategy directory",
          }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const dirPath = String(params.strategy_path);
            const result = await validateStrategy(dirPath);

            return json({
              valid: result.valid,
              error_count: result.errors.length,
              warning_count: result.warnings.length,
              errors: result.errors,
              warnings: result.warnings,
              message: result.valid
                ? `Strategy passed all checks (${result.warnings.length} warning(s))`
                : `Strategy has ${result.errors.length} error(s) that must be fixed`,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_backtest_strategy_check"] },
    );

    // === Tool 6: fin_backtest_remote_upload (alias for submit) ===
    api.registerTool(
      {
        name: "fin_backtest_remote_upload",
        label: "Remote Backtest — Upload & Submit",
        description:
          "Alias for fin_backtest_remote_submit. " +
          "Pack a local strategy directory into ZIP, upload to the remote Findoo Backtest Agent, " +
          "and optionally submit a backtest in one step.",
        parameters: Type.Object({
          strategy_path: Type.String({
            description: "Local path to the strategy directory",
          }),
          validate: Type.Optional(
            Type.Boolean({ description: "Run compliance check before upload (default: true)" }),
          ),
          archive_name: Type.Optional(
            Type.String({
              description: "Custom archive filename (default: strategy-<timestamp>.zip)",
            }),
          ),
          engine: Type.Optional(
            Type.Unsafe<string>({
              type: "string",
              enum: ["script", "agent"],
              description: "Backtest engine (if provided, submits backtest on upload)",
            }),
          ),
          symbol: Type.Optional(Type.String({ description: "Trading symbol (e.g. BTC-USD)" })),
          start_date: Type.Optional(
            Type.String({ description: "Backtest start date (YYYY-MM-DD)" }),
          ),
          end_date: Type.Optional(Type.String({ description: "Backtest end date (YYYY-MM-DD)" })),
          initial_capital: Type.Optional(Type.Number({ description: "Starting capital in USD" })),
          budget_cap_usd: Type.Optional(Type.Number({ description: "L2: Max LLM budget in USD" })),
          wait: Type.Optional(
            Type.Boolean({
              description: "Wait for backtest completion (default: true, only when engine given)",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const dirPath = String(params.strategy_path);
            const shouldValidate = params.validate !== false;

            if (shouldValidate) {
              const validation = await validateStrategy(dirPath);
              if (!validation.valid) {
                return json({
                  success: false,
                  message: `Compliance check failed: ${validation.errors.length} error(s)`,
                  errors: validation.errors,
                  warnings: validation.warnings,
                });
              }
            }

            // Pack
            const zipBuffer = await packStrategy(dirPath);
            const archiveName = params.archive_name
              ? String(params.archive_name)
              : `strategy-${Date.now()}.zip`;

            // Build upload params
            const uploadParams: UploadParams = {};
            if (params.engine) uploadParams.engine = params.engine as UploadParams["engine"];
            if (params.symbol) uploadParams.symbol = String(params.symbol);
            if (params.start_date) uploadParams.start_date = String(params.start_date);
            if (params.end_date) uploadParams.end_date = String(params.end_date);
            if (params.initial_capital != null)
              uploadParams.initial_capital = Number(params.initial_capital);
            if (params.budget_cap_usd != null)
              uploadParams.budget_cap_usd = Number(params.budget_cap_usd);

            // Upload (multipart POST /backtests)
            const submitResp = await client.submit(
              zipBuffer,
              archiveName,
              Object.keys(uploadParams).length > 0 ? uploadParams : undefined,
            );

            const result: Record<string, unknown> = {
              success: true,
              task_id: submitResp.task_id,
              status: submitResp.status,
              archive_size: zipBuffer.length,
              message: submitResp.message ?? "Upload successful",
            };

            // If engine was specified and wait is requested, poll for completion
            if (params.engine && params.wait !== false) {
              const pollResult = await pollUntilDone(client, submitResp.task_id, {
                intervalMs: config.pollIntervalMs,
                timeoutMs: config.pollTimeoutMs,
              });

              if (pollResult.report) {
                Object.assign(result, {
                  ...formatSummary(pollResult.report),
                  trade_journal_count: pollResult.report.trade_journal?.length ?? 0,
                  equity_points: pollResult.report.equity_curve?.length ?? 0,
                });
              } else {
                result.status = pollResult.task.status;
                result.message = "Task finished but no report available";
              }
            }

            return json(result);
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_backtest_remote_upload"] },
    );
  },
};

export default findooBacktestPlugin;
