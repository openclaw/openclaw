import { MessageChannel } from "node:worker_threads";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";

export async function loadAgentAuthProfileOperations() {
  const [
    { readAuthProfileRows },
    { sendAuthProfileUpdateValue },
    { readOpenClawAgentDatabaseIdentity },
  ] = await Promise.all([
    import("./sqlite-json.js"),
    import("./store-update-transfer.js"),
    import("../../state/openclaw-agent-db-identity.js"),
  ]);
  return {
    "authProfiles.read": (_input: undefined, { open }) => {
      const database = open();
      const identity = readOpenClawAgentDatabaseIdentity(database);
      const rows = readAuthProfileRows(database.db, database.path, "agent");
      const { port1, port2 } = new MessageChannel();
      try {
        sendAuthProfileUpdateValue(port1, rows);
        requestSqliteWorkerOperationAdmission(
          {
            stage: "prepare",
            facts: {
              kind: "auth-store-read",
              port: port2,
              identity: {
                kind: "file",
                physicalIdentity: identity.identity,
                birthtime: identity.birthtime,
                incarnation: identity.incarnation,
                nativeLocation: identity.filename,
              },
            },
          },
          [port2],
        );
      } finally {
        port1.close();
        port2.close();
      }
    },
  } satisfies WorkerOperationHandlers<AgentWorkerOperationContext>;
}
