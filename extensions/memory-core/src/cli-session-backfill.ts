import { runWithLocalStateOwner } from "openclaw/plugin-sdk/cli-state-owner";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import type { SessionBackfillExecution } from "./session-backfill-contract.js";
import { drainSessionBackfill } from "./session-backfill-drain.js";
import type { MemorySessionBackfillOptions } from "./session-backfill.js";

type RoutedBackfill = { execution: SessionBackfillExecution; ownerId: string };

export async function runMemorySessionBackfillCli(
  opts: MemorySessionBackfillOptions,
  hostOptions?: MemoryCoreRuntimeHost,
): Promise<void> {
  if (
    opts.rollback &&
    (opts.apply || opts.rem || opts.from || opts.to || opts.archiveFiles?.length)
  ) {
    throw new Error(
      "Memory session-backfill --rollback cannot be combined with input, range, --rem, or --apply options.",
    );
  }
  const operation = opts.rollback ? "rollback" : opts.apply ? "apply" : "preview";
  let operationOwnerId: string | undefined;
  const executeBatch = async (): Promise<RoutedBackfill | null> => {
    const reply = await runWithLocalStateOwner<RoutedBackfill | null>({
      method: `memory.sessionBackfill.${operation}.owner`,
      params: {
        agentId: opts.agent,
        ...(opts.rollback ? {} : { from: opts.from, to: opts.to, limitDays: opts.limitDays }),
        cliResult: true,
        ...(operationOwnerId ? { operationOwnerId } : {}),
      },
      target: "memory session backfill",
      recoveryCommand: "openclaw memory session-backfill --json",
      ...(opts.rem || opts.archiveFiles?.length ? { onForeignOwner: "refuse" as const } : {}),
      runLocal: async () => {
        if (operationOwnerId) {
          throw new Error(
            "The selected Gateway is no longer running; inspect the operation before retrying.",
          );
        }
        const runtime = await import("./cli.runtime.js");
        await runtime.runMemorySessionBackfill(opts, hostOptions);
        return null;
      },
    });
    if (reply) {
      operationOwnerId ??= reply.ownerId;
    }
    return reply;
  };
  const first = await executeBatch();
  if (!first) {
    return;
  }
  let initial: SessionBackfillExecution | undefined = first.execution;
  const result =
    opts.apply && !opts.rollback
      ? await drainSessionBackfill({
          executeBatch: async () => {
            if (initial) {
              const value = initial;
              initial = undefined;
              return value;
            }
            const next = await executeBatch();
            if (!next) {
              throw new Error("Memory backfill lost its Gateway owner.");
            }
            return next.execution;
          },
        })
      : first.execution.result;
  const { printSessionBackfillResult } = await import("./cli-rem.runtime.js");
  printSessionBackfillResult(result, opts);
}
