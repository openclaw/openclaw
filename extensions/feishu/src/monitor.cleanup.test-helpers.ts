import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { botNames, botOpenIds, httpServers, wsClients } from "./monitor.state.js";

export async function cleanupFeishuMonitorStateForTests(): Promise<void> {
  for (const client of wsClients.values()) {
    try {
      client.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
  wsClients.clear();

  for (const server of httpServers.values()) {
    try {
      server.closeAllConnections();
      server.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
  httpServers.clear();
  botOpenIds.clear();
  botNames.clear();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}
