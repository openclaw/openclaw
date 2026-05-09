import { updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

export async function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  try {
    return await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      updater: (store) => {
        store.profiles[params.profileId] = params.credential;
        return true;
      },
    });
  } catch {
    return null;
  }
}
