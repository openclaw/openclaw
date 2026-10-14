import type { SqliteWorkerCommand } from "openclaw/plugin-sdk/sqlite-runtime";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import type {
  ReportWorkerInput,
  ReportWorkerLog,
  ReportWorkerOperation,
  ReportWorkerResponse,
} from "./run-worker-contract.js";
import { createReportSources, generateReportPeriods } from "./run.js";
import type { TeamReportsOperations } from "./store-contract.js";
import { TeamReportsStore } from "./store.js";
import type { SummaryLlm } from "./summaries.js";
import type { Person, SourceRuntime } from "./types.js";

serveWorkerTasks(async (value, channel, control) => {
  if (!channel) {
    throw new Error("Team Reports requires a host task channel");
  }
  // SAFETY: Input is produced by the service-owned runner, never an external message.
  const input = value as ReportWorkerInput;
  const logs: ReportWorkerLog[] = [];
  let roster: Person[] | undefined;
  const request = async (operation: ReportWorkerOperation): Promise<unknown> => {
    control.throwIfCancelled();
    const reply = await channel.request({ ...operation, logs: logs.splice(0), roster });
    roster = undefined;
    // SAFETY: The host produces this paired response and retains it until this receipt.
    const response = reply.input as ReportWorkerResponse;
    reply.consumed();
    control.throwIfCancelled();
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response.value;
  };
  const logger: SourceRuntime["logger"] = {
    info: (message, meta) => logs.push({ level: "info", message, meta }),
    warn: (message, meta) => logs.push({ level: "warn", message, meta }),
    error: (message, meta) => logs.push({ level: "error", message, meta }),
  };
  const signal = new AbortController().signal;
  const store = new TeamReportsStore({
    async execute<Key extends keyof TeamReportsOperations>(command: {
      type: Key;
      input: TeamReportsOperations[Key]["input"];
    }) {
      const result = await request({
        kind: "store",
        // SAFETY: Both fields share the same operation key in this generic method.
        command: command as SqliteWorkerCommand<TeamReportsOperations>,
      });
      // SAFETY: The host typed dispatcher preserves this command/result correlation.
      return result as TeamReportsOperations[Key]["output"];
    },
    async close() {},
  });
  try {
    return await generateReportPeriods({
      ...input,
      store,
      runtime: { logger, signal },
      sources: (runtime) => createReportSources(runtime, Boolean(input.resolved.discord)),
      llm: {
        complete: async ({ signal: _signal, ...params }) => {
          // SAFETY: The service-owned host returns the configured completion result for this request.
          return (await request({ kind: "llm", params })) as Awaited<
            ReturnType<SummaryLlm["complete"]>
          >;
        },
      },
      onRoster: (people) => {
        roster = people;
      },
    });
  } finally {
    if (logs.length || roster) {
      await request({ kind: "flush" });
    }
  }
});
