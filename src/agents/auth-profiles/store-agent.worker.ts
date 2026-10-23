import { MessageChannel } from "node:worker_threads";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";

export async function loadAgentAuthProfileOperations() {
  const [{ readAuthProfileRows }, { sendAuthProfileUpdateValue }] = await Promise.all([
    import("./sqlite-json.js"),
    import("./store-update-transfer.js"),
  ]);
  return {
    "authProfiles.read": (_input: undefined, { open, admit }) => {
      const database = open();
      const rows = readAuthProfileRows(database.db, database.path, "agent");
      const { port1, port2 } = new MessageChannel();
      try {
        sendAuthProfileUpdateValue(port1, rows);
        admit("prepare", { kind: "auth-store-read", port: port2 }, [port2]);
      } finally {
        port1.close();
        port2.close();
      }
    },
  } satisfies WorkerOperationHandlers<AgentWorkerOperationContext>;
}
