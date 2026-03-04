import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { BacktestClient } from "./src/backtest-client.js";
import { resolveConfig } from "./src/config.js";
import { pollUntilDone } from "./src/poller.js";
import { toBacktestResult } from "./src/result-mapper.js";
import { packStrategy } from "./src/strategy-packer.js";
import { validateStrategy } from "./src/strategy-validator.js";
import type { RemoteReport, SubmitRequest } from "./src/types.js";

/* ---------- helpers ---------- */

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

function formatSummary(r: RemoteReport): Record<string, unknown> {
  const s = r.result_summary;
  return {
    task_id: r.task_id,
    total_return: `${(s.total_return * 100).toFixed(2)}%`,
    sharpe: s.sharpe_ratio.toFixed(3),
    sortino: s.sortino_ratio.toFixed(3),
    max_drawdown: `${(s.max_drawdown * 100).toFixed(2)}%`,
    calmar: s.calmar_ratio.toFixed(3),
    win_rate: `${(s.win_rate * 100).toFixed(1)}%`,
    profit_factor: s.profit_factor.toFixed(2),
    total_trades: s.total_trades,
    final_equity: s.final_equity.toFixed(2),
    ...(s.alpha != null ? { alpha: s.alpha.toFixed(4) } : {}),
    ...(s.beta != null ? { beta: s.beta.toFixed(4) } : {}),
  };
}

/* ---------- plugin ---------- */

const findooBacktestPlugin = {
  id: "findoo-backtest-plugin",
  name: "Findoo Backtest",
  description:
    "Remote backtesting via Findoo Backtest Agent — " +
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
      async submit(params: SubmitRequest, wait = true) {
        const task = await client.submit(params);
        if (!wait) return task;
        return pollUntilDone(client, task.task_id, {
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

    // === Tool 1: fin_backtest_remote_submit ===
    api.registerTool(
      {
        name: "fin_backtest_remote_submit",
        label: "Remote Backtest — Submit",
        description:
          "Submit a backtest to the remote Findoo Backtest Agent. " +
          "Supports L1 (script deterministic) and L2 (Agent+LLM intelligent) engines. " +
          "By default waits for completion and returns the full report summary.",
        parameters: Type.Object({
          strategy_dir: Type.String({
            description: "Server-side strategy directory path",
          }),
          engine: Type.Unsafe<string>({
            type: "string",
            enum: ["script", "agent"],
            description: "Backtest engine: 'script' (L1 deterministic) or 'agent' (L2 LLM-driven)",
          }),
          symbol: Type.Optional(Type.String({ description: "Trading symbol (default: BTC-USD)" })),
          initial_capital: Type.Optional(
            Type.Number({ description: "Starting capital in USD (default: 100000)" }),
          ),
          start_date: Type.String({ description: "Backtest start date (YYYY-MM-DD)" }),
          end_date: Type.String({ description: "Backtest end date (YYYY-MM-DD)" }),
          wait: Type.Optional(
            Type.Boolean({ description: "Wait for completion and return report (default: true)" }),
          ),
          csv_path: Type.Optional(
            Type.String({ description: "Custom CSV data file path on server" }),
          ),
          // L2 agent-specific
          budget_cap_usd: Type.Optional(Type.Number({ description: "L2: Max LLM budget in USD" })),
          max_turns_per_period: Type.Optional(
            Type.Number({ description: "L2: Max agent turns per period" }),
          ),
          agent_model: Type.Optional(Type.String({ description: "L2: LLM model name for agent" })),
          agent_mode: Type.Optional(Type.String({ description: "L2: Agent execution mode" })),
          reflection_interval: Type.Optional(
            Type.Number({ description: "L2: Periods between reflection steps" }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const req: SubmitRequest = {
              strategy_dir: String(params.strategy_dir),
              engine: params.engine as "script" | "agent",
              start_date: String(params.start_date),
              end_date: String(params.end_date),
            };
            if (params.symbol) req.symbol = String(params.symbol);
            if (params.initial_capital != null)
              req.initial_capital = Number(params.initial_capital);
            if (params.csv_path) req.csv_path = String(params.csv_path);
            if (params.budget_cap_usd != null) req.budget_cap_usd = Number(params.budget_cap_usd);
            if (params.max_turns_per_period != null)
              req.max_turns_per_period = Number(params.max_turns_per_period);
            if (params.agent_model) req.agent_model = String(params.agent_model);
            if (params.agent_mode) req.agent_mode = String(params.agent_mode);
            if (params.reflection_interval != null)
              req.reflection_interval = Number(params.reflection_interval);

            const wait = params.wait !== false; // default true
            const task = await client.submit(req);

            if (!wait) {
              return json({
                success: true,
                message: "Backtest submitted (async mode)",
                task_id: task.task_id,
                status: task.status,
              });
            }

            // Synchronous: poll until done
            const result = await pollUntilDone(client, task.task_id, {
              intervalMs: config.pollIntervalMs,
              timeoutMs: config.pollTimeoutMs,
            });

            if (!result.report) {
              return json({
                success: true,
                task_id: task.task_id,
                status: result.task.status,
                message: "Task finished but no report available",
              });
            }

            return json({
              success: true,
              ...formatSummary(result.report),
              trades_count: result.report.trades?.length ?? 0,
              equity_points: result.report.equity_curve?.length ?? 0,
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
                trades_count: report.trades?.length ?? 0,
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
                engine: t.engine,
                symbol: t.symbol,
                created_at: t.created_at,
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
        description: "Cancel a queued or running remote backtest task.",
        parameters: Type.Object({
          task_id: Type.String({ description: "Backtest task ID to cancel" }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const taskId = String(params.task_id);
            const result = await client.cancelTask(taskId);
            return json({
              success: result.success,
              task_id: taskId,
              message: result.success ? "Task cancelled" : "Cancel request sent",
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
          "Validate a local strategy directory against FEP 1.0 specification. " +
          "Checks structure (fep.yaml, strategy.py), Python interface (Strategy class, execute method), " +
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

    // === Tool 6: fin_backtest_remote_upload ===
    api.registerTool(
      {
        name: "fin_backtest_remote_upload",
        label: "Remote Backtest — Upload & Submit",
        description:
          "Pack a local strategy directory into ZIP, upload to the remote Findoo Backtest Agent, " +
          "and optionally submit a backtest in one step. " +
          "By default runs compliance check before uploading. " +
          "Returns task_id if backtest params are provided, or upload confirmation otherwise.",
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
          // Optional: submit backtest together with upload
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

            // Pack
            const tarBuffer = await packStrategy(dirPath);
            const archiveName = params.archive_name
              ? String(params.archive_name)
              : `strategy-${Date.now()}.zip`;

            // Build optional upload params
            const uploadParams: Record<string, string | number> = {};
            if (params.engine) uploadParams.engine = String(params.engine);
            if (params.symbol) uploadParams.symbol = String(params.symbol);
            if (params.start_date) uploadParams.start_date = String(params.start_date);
            if (params.end_date) uploadParams.end_date = String(params.end_date);
            if (params.initial_capital != null)
              uploadParams.initial_capital = Number(params.initial_capital);
            if (params.budget_cap_usd != null)
              uploadParams.budget_cap_usd = Number(params.budget_cap_usd);

            // Upload (+ optional submit)
            const uploadResult = await client.uploadStrategy(
              tarBuffer,
              archiveName,
              Object.keys(uploadParams).length > 0 ? uploadParams : undefined,
            );

            const result: Record<string, unknown> = {
              success: true,
              task_id: uploadResult.task_id,
              status: uploadResult.status,
              archive_size: tarBuffer.length,
              message: uploadResult.message,
            };

            // If engine was specified and wait is requested, poll for completion
            if (params.engine && params.wait !== false) {
              const pollResult = await pollUntilDone(client, uploadResult.task_id, {
                intervalMs: config.pollIntervalMs,
                timeoutMs: config.pollTimeoutMs,
              });

              if (pollResult.report) {
                Object.assign(result, {
                  ...formatSummary(pollResult.report),
                  trades_count: pollResult.report.trades?.length ?? 0,
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
