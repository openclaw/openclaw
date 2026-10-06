import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import type { IncognitoSessionActor } from "../../config/sessions/session-incognito-actor.js";
import { captureIncognitoSessionOperation } from "../../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../../config/sessions/session-incognito-contract.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerCommand, SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { recordContextEngineTurnOutboxSchemaCommitted } from "../../state/openclaw-agent-context-engine-turn-outbox-schema.js";
import {
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseRuntime,
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
        withOpenClawAgentDatabaseRuntime(
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
    [
      Type in
        | "prepareRun"
        | "enqueueIntent"
        | "acceptIntent"
        | "publishClosedTurn"
        | "discardIntent"
    ]: (
      input: ContextEngineTurnOutboxWorkerOperations[Type]["input"],
    ) => Promise<
      ContextEngineTurnOutboxWorkerOperations[Type]["output"] extends undefined
        ? void
        : ContextEngineTurnOutboxWorkerOperations[Type]["output"]
    >;
  }>;

export function openContextEngineTurnOutboxWorkerStore(target: {
  agentId: string;
  path: string;
  sessionKey?: string;
  sessionId?: string;
  incognito?: {
    actor: IncognitoSessionActor;
    authority: IncognitoSessionAuthority;
    sessionKey: string;
    sessionId: string;
  };
}): ContextEngineTurnOutboxWorkerStore {
  const captured = { ...target };
  const binding =
    target.incognito ??
    captureIncognitoSessionOperation({
      ...target,
      storePath: target.path,
    });
  const incognito = binding && {
    ...binding,
    sessionKey: target.incognito?.sessionKey ?? target.sessionKey,
    sessionId: target.incognito?.sessionId ?? target.sessionId,
  };
  if (
    incognito &&
    (incognito.actor.agentId !== captured.agentId || incognito.actor.path !== captured.path)
  ) {
    throw new Error("Outbox target differs from its captured incognito actor");
  }
  const executeActor =
    incognito &&
    (() => {
      const { actor, authority } = incognito;
      const { sessionKey, sessionId } = incognito;
      if (!sessionKey || !sessionId) {
        throw new Error("Incognito outbox requires its captured session target");
      }
      const scoped = <Input extends object>(input: Input) => ({ ...input, sessionKey, sessionId });
      const commands: {
        [Key in keyof ContextEngineTurnOutboxWorkerOperations]: (
          input: ContextEngineTurnOutboxWorkerOperations[Key]["input"],
        ) => Promise<ContextEngineTurnOutboxWorkerOperations[Key]["output"]>;
      } = {
        prepareRun: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.prepareRun",
            input: scoped(input),
          }),
        listPendingSessions: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.listPendingSessions",
            input: scoped(input),
          }),
        readNextPending: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.readNextPending",
            input: scoped(input),
          }),
        complete: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.complete",
            input: scoped(input),
          }),
        recordFailure: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.recordFailure",
            input: scoped(input),
          }),
        hasPending: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.hasPending",
            input: scoped(input),
          }),
        enqueueIntent: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.enqueueIntent",
            input: scoped(input),
          }),
        acceptIntent: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.acceptIntent",
            input: scoped(input),
          }),
        publishClosedTurn: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.publishClosedTurn",
            input: scoped(input),
          }),
        discardIntent: (input) =>
          actor.sessions.outbox(authority, {
            type: "session.outbox.discardIntent",
            input: scoped(input),
          }),
      };
      const execute: SqliteWorkerStore<ContextEngineTurnOutboxWorkerOperations>["execute"] = ({
        type,
        input,
      }) => {
        if (
          ("sessionId" in input &&
            input.sessionId !== undefined &&
            input.sessionId !== sessionId) ||
          ("sessionKey" in input &&
            input.sessionKey !== undefined &&
            input.sessionKey !== sessionKey)
        ) {
          throw new Error("Outbox command differs from its captured incognito session");
        }
        return commands[type](input);
      };
      return execute;
    })();
  const run = <Type extends OutboxCommand["type"]>(
    command: Extract<OutboxCommand, { type: Type }>,
  ) => {
    if (executeActor) {
      return executeActor<Type>(command).then((value) => {
        if (command.type === "listPendingSessions" || command.type === "readNextPending") {
          incognito?.authority.assertCurrent();
          incognito?.actor.assertReadable();
        }
        return value;
      });
    }
    // SAFETY: executeContextEngineTurnOutboxCommand returns each command type's declared output.
    return runContextEngineTurnOutboxCommand(captured, command) as Promise<
      ContextEngineTurnOutboxWorkerOperations[Type]["output"]
    >;
  };
  return {
    ...(incognito
      ? {
          retain: <T>(operation: () => Promise<T>) =>
            incognito.actor.sessions.withSharedState(operation),
          assertReadable() {
            incognito.authority.assertCurrent();
            incognito.actor.assertReadable();
          },
        }
      : {}),
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
