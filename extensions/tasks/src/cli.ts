import type { Command } from "commander";
import type { OpenClawConfig, PluginOperationsRuntime } from "openclaw/plugin-sdk/plugin-entry";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import {
  runTasksAudit,
  runTasksCancel,
  runTasksList,
  runTasksMaintenance,
  runTasksNotify,
  runTasksShow,
} from "./cli.runtime.js";

function parsePositiveIntOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function registerTasksCli(
  program: Command,
  deps: {
    config: OpenClawConfig;
    operations: PluginOperationsRuntime;
  },
) {
  const tasks = program
    .command("tasks")
    .description("Inspect durable background task state")
    .option("--json", "Output as JSON", false)
    .option("--runtime <name>", "Filter by kind (subagent, acp, cron, cli)")
    .option(
      "--status <name>",
      "Filter by status (queued, running, succeeded, failed, timed_out, cancelled, lost)",
    )
    .action(async (opts) => {
      await runTasksList(
        {
          json: Boolean(opts.json),
          runtime: opts.runtime as string | undefined,
          status: opts.status as string | undefined,
        },
        deps,
        defaultRuntime,
      );
    });
  tasks.enablePositionalOptions();

  tasks
    .command("list")
    .description("List tracked background tasks")
    .option("--json", "Output as JSON", false)
    .option("--runtime <name>", "Filter by kind (subagent, acp, cron, cli)")
    .option(
      "--status <name>",
      "Filter by status (queued, running, succeeded, failed, timed_out, cancelled, lost)",
    )
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as
        | {
            json?: boolean;
            runtime?: string;
            status?: string;
          }
        | undefined;
      await runTasksList(
        {
          json: Boolean(opts.json || parentOpts?.json),
          runtime: (opts.runtime as string | undefined) ?? parentOpts?.runtime,
          status: (opts.status as string | undefined) ?? parentOpts?.status,
        },
        deps,
        defaultRuntime,
      );
    });

  tasks
    .command("audit")
    .description("Show stale or broken background task runs")
    .option("--json", "Output as JSON", false)
    .option("--severity <level>", "Filter by severity (warn, error)")
    .option("--code <name>", "Filter by finding code")
    .option("--limit <n>", "Limit displayed findings")
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as { json?: boolean } | undefined;
      await runTasksAudit(
        {
          json: Boolean(opts.json || parentOpts?.json),
          severity: opts.severity as "warn" | "error" | undefined,
          code: opts.code as string | undefined,
          limit: parsePositiveIntOrUndefined(opts.limit),
        },
        deps,
        defaultRuntime,
      );
    });

  tasks
    .command("maintenance")
    .description("Preview or apply task ledger maintenance")
    .option("--json", "Output as JSON", false)
    .option("--apply", "Apply reconciliation, cleanup stamping, and pruning", false)
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as { json?: boolean } | undefined;
      await runTasksMaintenance(
        {
          json: Boolean(opts.json || parentOpts?.json),
          apply: Boolean(opts.apply),
        },
        deps,
        defaultRuntime,
      );
    });

  tasks
    .command("show")
    .description("Show one background task by task id, run id, or session key")
    .argument("<lookup>", "Task id, run id, or session key")
    .option("--json", "Output as JSON", false)
    .action(async (lookup, opts, command) => {
      const parentOpts = command.parent?.opts() as { json?: boolean } | undefined;
      await runTasksShow(
        {
          lookup,
          json: Boolean(opts.json || parentOpts?.json),
        },
        deps,
        defaultRuntime,
      );
    });

  tasks
    .command("notify")
    .description("Set task notify policy")
    .argument("<lookup>", "Task id, run id, or session key")
    .argument("<notify>", "Notify policy (done_only, state_changes, silent)")
    .action(async (lookup, notify) => {
      await runTasksNotify(
        {
          lookup,
          notify: notify as "done_only" | "state_changes" | "silent",
        },
        deps,
        defaultRuntime,
      );
    });

  tasks
    .command("cancel")
    .description("Cancel a running background task")
    .argument("<lookup>", "Task id, run id, or session key")
    .action(async (lookup) => {
      await runTasksCancel(
        {
          lookup,
        },
        deps,
        defaultRuntime,
      );
    });
}
