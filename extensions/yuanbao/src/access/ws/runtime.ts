import type { YuanbaoWsClient } from "./client.js";

const activeClients = new Map<string, YuanbaoWsClient>();

export function setActiveWsClient(accountId: string, client: YuanbaoWsClient | null): void {
  if (client) {
    activeClients.set(accountId, client);
  } else {
    activeClients.delete(accountId);
  }
}

export function getActiveWsClient(accountId: string): YuanbaoWsClient | null {
  return activeClients.get(accountId) ?? null;
}

export function getAllActiveWsClients(): ReadonlyMap<string, YuanbaoWsClient> {
  return activeClients;
}
