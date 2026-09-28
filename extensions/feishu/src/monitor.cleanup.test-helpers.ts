import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { botNames, botOpenIds, wsClients } from "./monitor.state.js";

export async function cleanupFeishuMonitorStateForTests(): Promise<void> {
  for (const client of wsClients.values()) {
    try {
      client.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
  wsClients.clear();

  botOpenIds.clear();
  botNames.clear();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}
