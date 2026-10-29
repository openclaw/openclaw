import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";

export function readAuthProfileStore(agentDir: string): AuthProfileStore {
  return loadAuthProfileStoreWithoutExternalProfiles(agentDir);
}

export function writeAuthProfileStore(agentDir: string, store: AuthProfileStore): void {
  saveAuthProfileStore(store, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}
