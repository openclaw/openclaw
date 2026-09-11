import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthProfileCredential } from "./types.js";

type SetupCredentialAccess = {
  profileId: string;
  agentDir?: string;
  isActive: () => boolean;
};

const setupCredentialAccess = new AsyncLocalStorage<SetupCredentialAccess>();

export function isSetupCredentialAccessible(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): boolean {
  if (!params.credential.setup?.replacement) {
    return true;
  }
  const access = setupCredentialAccess.getStore();
  return Boolean(
    access?.isActive() &&
    access.profileId === params.profileId &&
    (params.agentDir === undefined || access.agentDir === params.agentDir),
  );
}

/** Allows the selected replacement only while its setup operation remains active. */
export async function withSetupCredentialAccess<T>(
  params: { profileId: string; agentDir?: string; signal?: AbortSignal },
  run: () => Promise<T>,
): Promise<T> {
  const parent = setupCredentialAccess.getStore();
  let active = true;
  return await setupCredentialAccess.run(
    {
      profileId: params.profileId,
      agentDir: params.agentDir,
      isActive: () => active && !params.signal?.aborted && (!parent || parent.isActive()),
    },
    async () => {
      try {
        return await run();
      } finally {
        active = false;
      }
    },
  );
}
