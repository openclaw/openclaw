import {
  createCodexAppServerStartupLifetime,
  getSharedCodexAppServerClientState,
} from "./shared-client-lifecycle.js";

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  state.startup.controller.abort();
  state.startup = createCodexAppServerStartupLifetime();
  const clients = [...state.liveClients];
  const isolatedClients = [...state.isolatedClients];
  state.clients.clear();
  state.liveClients.clear();
  state.isolatedClients.clear();
  state.entriesByClient = new WeakMap();
  for (const client of [...clients, ...isolatedClients]) {
    client.close();
  }
}
