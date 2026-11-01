import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import {
  captureSessionActorStorageOwner,
  type SessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import {
  resolveExplicitIncognitoAgentSqliteTarget,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { openMemoryContextEngineTurnOutboxStore } from "./context-engine-turn-outbox-memory.js";
import type {
  ContextEngineTurnOutboxWorkerStore,
  ContextEngineTurnOutboxWorkerOperations,
} from "./context-engine-turn-outbox.js";

type OutboxCommand = SqliteWorkerCommand<ContextEngineTurnOutboxWorkerOperations>;

/**
 * Runs one outbox command in the agent database worker. The host thread only
 * awaits it, so a worker transaction waiting on this thread for its commit
 * grant is never blocked by synchronous SQLite here.
 */
async function runContextEngineTurnOutboxCommand(
  target: { agentId: string; path: string },
  command: OutboxCommand,
): Promise<unknown> {
  if (resolveExplicitIncognitoAgentSqliteTarget(target.path, { agentId: target.agentId })) {
    throw new IncognitoSessionMissingError();
  }
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    agentId: target.agentId,
    env,
    path: resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env, path: target.path }),
  };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  try {
    const worker =
      await openOpenClawAgentSqliteWorkerStore<ContextEngineTurnOutboxWorkerOperations>(
        options,
        { execution },
        {
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.contextEngineTurnOutbox),
          input: undefined,
        },
      );
    try {
      return await worker.execute(command, () => execution.assertCurrent());
    } finally {
      await worker.close();
    }
  } finally {
    await execution.release();
  }
}

export function openContextEngineTurnOutboxWorkerStore(target: {
  agentId: string;
  path: string;
  sessionKey?: string;
  sessionId?: string;
  sessionActor?: SessionActorStorageBinding;
}): ContextEngineTurnOutboxWorkerStore {
  const scope = { ...target, storePath: target.path };
  const memory = captureSessionActorStorageOwner(scope, { assertCurrent() {}, authorize() {} });
  if (memory) {
    return openMemoryContextEngineTurnOutboxStore(scope, memory);
  }
  const captured = { ...target };
  const run = <Type extends OutboxCommand["type"]>(
    command: Extract<OutboxCommand, { type: Type }>,
  ) => {
    // SAFETY: executeContextEngineTurnOutboxCommand returns each command type's declared output.
    return runContextEngineTurnOutboxCommand(captured, command) as Promise<
      ContextEngineTurnOutboxWorkerOperations[Type]["output"]
    >;
  };
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
    enqueueIntent: (input) => run({ type: "enqueueIntent", input }),
    acceptIntent: (input) => run({ type: "acceptIntent", input }),
    publishClosedTurn: (input) => run({ type: "publishClosedTurn", input }),
    discardIntent: (input) => run({ type: "discardIntent", input }),
  };
}
