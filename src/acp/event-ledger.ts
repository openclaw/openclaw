import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  createAcpPromptUpdates,
  normalizeAcpLedgerOptions,
  type AcpEventLedger,
  type AcpLedgerOptions,
} from "./event-ledger.types.js";
import type { AcpReplayWorkerOperations } from "./event-ledger.worker-contract.js";

export type { AcpEventLedger, AcpEventLedgerReplay } from "./event-ledger.types.js";

export function createSqliteAcpEventLedger(
  params: OpenClawStateDatabaseOptions & AcpLedgerOptions = {},
): AcpEventLedger {
  const { now, ...limits } = normalizeAcpLedgerOptions(params);
  const execute = <Key extends keyof AcpReplayWorkerOperations>(
    type: Key,
    input: AcpReplayWorkerOperations[Key]["input"],
  ): Promise<AcpReplayWorkerOperations[Key]["output"]> => {
    const context = captureOpenClawStateWorkerContext({ env: params.env, path: params.path });
    return runOpenClawStateWorkerOperation(context, (scope) => scope.execute({ type, input }));
  };
  return {
    startSession: (session) => execute("acpReplay.start", { session, limits, now: now() }),
    recordUserPrompt: ({ prompt, ...session }) =>
      execute("acpReplay.append", {
        session,
        limits,
        events: createAcpPromptUpdates(prompt).map((update) => ({
          update,
          createdAt: now(),
          at: now(),
        })),
      }),
    recordUpdate: ({ update, ...session }) =>
      execute("acpReplay.append", {
        session,
        limits,
        events: [{ update: structuredClone(update), createdAt: now(), at: now() }],
      }),
    markIncomplete: (session) => execute("acpReplay.incomplete", { ...session, now: now() }),
    readReplay: ({ sessionId, sessionKey }) =>
      execute("acpReplay.read", { kind: "bound", sessionId, sessionKey }),
    readReplayBySessionId: ({ sessionId }) => execute("acpReplay.read", { kind: "id", sessionId }),
    readReplayBySessionKey: ({ sessionKey }) =>
      execute("acpReplay.read", { kind: "key", sessionKey }),
  };
}
