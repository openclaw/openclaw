import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "./runtime-snapshots.js";
import type { AuthProfileCredential } from "./types.js";

export type SetupRuntimeCredential = {
  source: AuthProfileCredential;
  materialized: AuthProfileCredential;
  credentialsRevision: number;
};

type SetupCredentialAccess = {
  profileId: string;
  agentDir?: string;
  isActive: () => boolean;
  runtimeCredential?: SetupRuntimeCredential;
};

const setupCredentialAccess = new AsyncLocalStorage<SetupCredentialAccess>();

/** Detached runtime work must not inherit a writer's temporary credential access. */
export function runOutsideSetupCredentialAccess<T>(run: () => T): T {
  return setupCredentialAccess.exit(run);
}

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

/** Reads only the exact, still-owned SecretRef materialization for the current setup operation. */
export function getSetupCredentialRuntimeProfile(params: {
  profileId: string;
  profile: AuthProfileCredential;
  agentDir?: string;
}): AuthProfileCredential | null | undefined {
  const access = setupCredentialAccess.getStore();
  const runtime = access?.runtimeCredential;
  if (
    !access ||
    !runtime ||
    access.profileId !== params.profileId ||
    access.agentDir !== params.agentDir
  ) {
    return undefined;
  }
  if (
    !access.isActive() ||
    runtime.credentialsRevision !== getRuntimeAuthProfileStoreCredentialsRevision() ||
    !isDeepStrictEqual(runtime.source, params.profile)
  ) {
    // A revoked scoped owner cannot borrow a replacement global materialization.
    return null;
  }
  return structuredClone(runtime.materialized);
}

/** Allows the selected replacement only while its setup operation remains active. */
export async function withSetupCredentialAccess<T>(
  params: {
    profileId: string;
    agentDir?: string;
    signal?: AbortSignal;
    runtimeCredential?: SetupRuntimeCredential;
  },
  run: () => Promise<T>,
): Promise<T> {
  const parent = setupCredentialAccess.getStore();
  let active = true;
  return await setupCredentialAccess.run(
    {
      profileId: params.profileId,
      agentDir: params.agentDir,
      runtimeCredential: params.runtimeCredential
        ? structuredClone(params.runtimeCredential)
        : parent?.profileId === params.profileId && parent.agentDir === params.agentDir
          ? parent.runtimeCredential
          : undefined,
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
