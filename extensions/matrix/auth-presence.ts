import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-store-runtime";
import {
  MATRIX_CREDENTIALS_MAX_ENTRIES,
  MATRIX_CREDENTIALS_NAMESPACE,
  normalizeMatrixStoredCredentials,
  type MatrixCredentialStateRecord,
} from "./src/matrix/credentials-state.js";

type MatrixAuthPresenceParams =
  | {
      cfg: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
    }
  | OpenClawConfig;

/** @deprecated Use hasAnyMatrixAuthAsync. This adapter will be removed in the next Plugin SDK major. */
export function hasAnyMatrixAuth(
  params: MatrixAuthPresenceParams,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const resolvedEnv =
    params && typeof params === "object" && "cfg" in params ? (params.env ?? env) : env;
  try {
    const store = createPluginStateSyncKeyedStore<MatrixCredentialStateRecord>("matrix", {
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: resolvedEnv,
    });
    return store.entries().some((entry) => normalizeMatrixStoredCredentials(entry.value) !== null);
  } catch {
    return false;
  }
}

export async function hasAnyMatrixAuthAsync(
  params: MatrixAuthPresenceParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const resolvedEnv =
    params && typeof params === "object" && "cfg" in params ? (params.env ?? env) : env;
  try {
    const store = createPluginStateKeyedStore<MatrixCredentialStateRecord>("matrix", {
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: resolvedEnv,
    });
    return (await store.entries()).some(
      (entry) => normalizeMatrixStoredCredentials(entry.value) !== null,
    );
  } catch {
    return false;
  }
}
