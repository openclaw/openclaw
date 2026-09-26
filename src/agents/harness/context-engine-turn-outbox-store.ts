import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import type {
  TranscriptTurnAdmission,
  TranscriptTurnBoundary,
} from "../../config/sessions/transcript-entry-anchor.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { recordContextEngineTurnOutboxSchemaCommitted } from "../../state/openclaw-agent-context-engine-turn-outbox-schema.js";
import {
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  executeContextEngineTurnOutboxCommand,
  type ContextEngineTurnOutboxStore,
  type ContextEngineTurnOutboxWorkerOperations,
  type ContextEngineTurnRuntimeContext,
} from "./context-engine-turn-outbox.js";

type OutboxCommand = SqliteWorkerCommand<ContextEngineTurnOutboxWorkerOperations>;
type OutboxOwner = { engineId: string; ownerPluginId?: string };

/**
 * Runs one outbox command in the agent database worker. The host thread only
 * awaits it, so a worker transaction waiting on this thread for its commit
 * grant is never blocked by synchronous SQLite here.
 */
async function runContextEngineTurnOutboxCommand(
  target: { agentId: string; path: string },
  command: OutboxCommand,
): Promise<unknown> {
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    agentId: target.agentId,
    env,
    path: resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env, path: target.path }),
  };
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    // Incognito retains its sole in-memory owner until that owner is migrated as a whole.
    let committedDb: DatabaseSync | undefined;
    const result = await runOpenClawAgentWriteAdmission(
      options,
      () =>
        runOpenClawAgentWriteTransaction(
          ({ db }) => {
            committedDb = db;
            return executeContextEngineTurnOutboxCommand(db, command);
          },
          options,
          { operationLabel: `context-engine.turn-outbox.${command.type}` },
        ),
      true,
    );
    // The transaction committed its lazy DDL; later commands on this connection skip it.
    if (committedDb) {
      recordContextEngineTurnOutboxSchemaCommitted(committedDb);
    }
    return result;
  }
  // Retain the lifecycle before queuing so close cannot turn waiting work into a fresh open.
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const assertCurrent = () => execution.assertCurrent();
  try {
    return await runOpenClawAgentWriteAdmission(
      options,
      () =>
        withOpenClawAgentDatabaseAsync(
          options,
          async ({ db }) => {
            assertCurrent();
            const worker =
              await openOpenClawAgentSqliteWorkerStore<ContextEngineTurnOutboxWorkerOperations>(
                options,
                db,
                {
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.contextEngineTurnOutbox,
                  ),
                  input: undefined,
                },
              );
            try {
              return await worker.execute(command, assertCurrent);
            } finally {
              await worker.close();
            }
          },
          assertCurrent,
        ),
      true,
    );
  } finally {
    await execution.release();
  }
}

/** The durable context-engine turn outbox of one agent database, executed in its worker. */
export type ContextEngineTurnOutboxWorkerStore = ContextEngineTurnOutboxStore &
  Readonly<{
    prepareRun(
      input: OutboxOwner & {
        admission?: TranscriptTurnAdmission;
        isHeartbeat: boolean;
        sessionId: string;
      },
    ): Promise<ContextEngineTurnOutboxWorkerOperations["prepareRun"]["output"]>;
    enqueueIntent(
      input: OutboxOwner & { admission: TranscriptTurnAdmission; isHeartbeat: boolean },
    ): Promise<void>;
    acceptIntent(
      input: OutboxOwner & {
        boundary: TranscriptTurnBoundary;
        isHeartbeat: boolean;
        runtimeContext?: ContextEngineTurnRuntimeContext;
      },
    ): Promise<void>;
    publishClosedTurn(
      input: OutboxOwner & {
        boundary: TranscriptTurnBoundary;
        isHeartbeat: boolean;
        maxBytes: number;
        maxEvents: number;
        runtimeContext?: ContextEngineTurnRuntimeContext;
      },
    ): Promise<ContextEngineTurnOutboxWorkerOperations["publishClosedTurn"]["output"]>;
    discardIntent(input: OutboxOwner & { admission: TranscriptTurnAdmission }): Promise<void>;
  }>;

export function openContextEngineTurnOutboxWorkerStore(target: {
  agentId: string;
  path: string;
}): ContextEngineTurnOutboxWorkerStore {
  const run = <Type extends OutboxCommand["type"]>(
    command: Extract<OutboxCommand, { type: Type }>,
  ) =>
    // SAFETY: executeContextEngineTurnOutboxCommand returns each command type's declared output.
    runContextEngineTurnOutboxCommand(target, command) as Promise<
      ContextEngineTurnOutboxWorkerOperations[Type]["output"]
    >;
  return {
    prepareRun: (input) => run({ type: "prepareRun", input }),
    listPendingSessions: (input) => run({ type: "listPendingSessions", input }),
    readNextPending: (input) => run({ type: "readNextPending", input }),
    complete: async (advancementKey) => {
      await run({ type: "complete", input: { advancementKey } });
    },
    recordFailure: async (advancementKey, message, attemptedAt) => {
      await run({ type: "recordFailure", input: { advancementKey, message, attemptedAt } });
    },
    hasPending: (input) => run({ type: "hasPending", input }),
    enqueueIntent: async (input) => {
      await run({ type: "enqueueIntent", input });
    },
    acceptIntent: async (input) => {
      await run({ type: "acceptIntent", input });
    },
    publishClosedTurn: (input) => run({ type: "publishClosedTurn", input }),
    discardIntent: async (input) => {
      await run({ type: "discardIntent", input });
    },
  };
}
