import path from "node:path";
import {
  loadAuthProfileStoreForRuntimeAsync,
  type AuthProfileCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";

export async function writeQaAuthProfiles(params: {
  agentId: string;
  profiles: Record<string, AuthProfileCredential>;
  replace?: boolean;
  stateDir: string;
}): Promise<void> {
  const agentDir = path.join(params.stateDir, "agents", params.agentId, "agent");
  // Surface pending legacy-source errors before the locked updater, whose
  // public failure contract is intentionally nullable.
  await readQaAuthProfiles(agentDir);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    stateDir: params.stateDir,
    saveOptions: {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    },
    updater: (store) => {
      store.version = 1;
      store.profiles = params.replace
        ? { ...params.profiles }
        : { ...store.profiles, ...params.profiles };
      if (params.replace) {
        delete store.order;
        delete store.lastGood;
        delete store.usageStats;
      }
      return true;
    },
  });
  if (!updated) {
    throw new Error("Failed to stage the isolated QA auth profile store.");
  }
}

export async function readQaAuthProfiles(agentDir: string): Promise<{
  version: number;
  profiles: Record<string, AuthProfileCredential>;
}> {
  const store = await loadAuthProfileStoreForRuntimeAsync(
    agentDir,
    { inheritedAuthDir: agentDir, readOnly: true, externalCli: { mode: "none" } },
    { ...process.env, OPENCLAW_STATE_DIR: path.resolve(agentDir, "../../..") },
  );
  return {
    version: store.version,
    profiles: store.profiles,
  };
}
