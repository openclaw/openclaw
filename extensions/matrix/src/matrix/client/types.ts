import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import type { SsrFPolicy } from "../../runtime-api.js";

export type MatrixResolvedConfig = {
  homeserver: string;
  userId: string;
  accessToken?: string;
  deviceId?: string;
  password?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
};

/**
 * Authenticated Matrix configuration.
 * Note: deviceId is NOT included here because it's implicit in the accessToken.
 * Matrix storage reuses the most complete account-scoped root it can find for the
 * same homeserver/user/account tuple so token refreshes do not strand prior state.
 * If the device identity itself changes or crypto storage is lost, crypto state may
 * still need to be recreated together with the new access token.
 */
export type MatrixAuth = {
  accountId: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
};

export type MatrixStoragePaths = {
  stateDir: string;
  rootDir: string;
  recoveryKeyStorageKey: string;
  idbSnapshotStorageKey: string;
  accountKey: string;
  tokenHash: string;
};
