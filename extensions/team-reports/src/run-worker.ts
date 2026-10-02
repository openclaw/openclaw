import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import {
  REPORT_RUN_TIMEOUT_MS,
  type ReportRunRequest,
  type ReportWorkerInput,
  type ReportWorkerRequest,
  type ReportWorkerResponse,
} from "./run-worker-contract.js";
import type { SourceStatus } from "./types.js";

export class TeamReportsRunner {
  private readonly pool;
  private readonly requests = new Set<Promise<unknown>>();

  constructor(workerUrl: URL) {
    // Long network collection owns one ordered worker, not a shared CPU permit.
    this.pool = new WorkerTaskPool<ReportWorkerInput, Record<string, SourceStatus>>({
      workerUrl,
      maxWorkers: 1,
      maxPendingTasks: 1,
    });
  }

  async run(params: ReportRunRequest): Promise<Record<string, SourceStatus>> {
    const deadline = Date.now() + REPORT_RUN_TIMEOUT_MS;
    try {
      return await this.pool.run(
        {
          config: params.config,
          resolved: params.resolved,
          periods: params.periods,
          reuseCollectedDays: params.reuseCollectedDays,
        },
        {
          signal: params.runtime.signal,
          timeoutMs: REPORT_RUN_TIMEOUT_MS,
          onRequest: (value, { signal }) => {
            // SAFETY: The private worker owns this protocol; source responses never dispatch host calls.
            const request = value as ReportWorkerRequest;
            const pending = (async () => {
              signal.throwIfAborted();
              for (const log of request.logs) {
                params.runtime.logger[log.level]?.(log.message, log.meta);
              }
              if (request.roster) {
                params.onRoster(request.roster);
              }
              let response: ReportWorkerResponse;
              try {
                const result =
                  request.kind === "store"
                    ? await params.store.execute(request.command.type, request.command.input, {
                        signal,
                      })
                    : request.kind === "llm"
                      ? await params.llm.complete({ ...request.params, signal })
                      : undefined;
                response = { ok: true, value: result };
              } catch (error) {
                response = {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
              signal.throwIfAborted();
              return { input: response, timeoutMs: Math.max(1, deadline - Date.now()) };
            })();
            this.requests.add(pending);
            void pending.finally(() => this.requests.delete(pending)).catch(() => {});
            return pending;
          },
        },
      );
    } finally {
      // Pool retirement joins the isolate; accepted host writes and LLM cleanup also need settlement.
      await Promise.allSettled(this.requests);
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.close();
    } finally {
      await Promise.allSettled(this.requests);
    }
  }
}
