import { readConfigMachineState } from "../../state/config-machine-state.js";
import {
  getPreparedSharedAuthStoreOwnership,
  noteCommittedSharedAuthStoreOwnership,
  parseSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
  SHARED_AUTH_STORE_STATE_KEY,
} from "./path-resolve.js";
import type { SharedAuthStoreOwnership } from "./types.js";

/** Inspect copied state without pinning a runtime owner or changing SQLite artifacts. */
export function inspectSharedAuthStoreOwnership(
  env: NodeJS.ProcessEnv = process.env,
): SharedAuthStoreOwnership {
  return parseSharedAuthStoreOwnership(
    readConfigMachineState<unknown>(
      SHARED_AUTH_STORE_STATE_KEY,
      { env },
      { artifactPreservingReadOnly: true },
    ),
  );
}

/** Doctor, offline CLI and the deprecated synchronous auth SDK prepare their native owner. */
export function prepareSharedAuthStoreOwnershipForNative(
  env: NodeJS.ProcessEnv = process.env,
): SharedAuthStoreOwnership {
  const cached = getPreparedSharedAuthStoreOwnership(env);
  if (cached) {
    return cached;
  }
  const ownership = parseSharedAuthStoreOwnership(
    readConfigMachineState<unknown>(SHARED_AUTH_STORE_STATE_KEY, { env }),
  );
  noteCommittedSharedAuthStoreOwnership(ownership, env);
  return ownership;
}

export function resolveNativeSharedAuthStorePath(env: NodeJS.ProcessEnv = process.env): string {
  prepareSharedAuthStoreOwnershipForNative(env);
  return resolveSharedAuthStorePath(env);
}
