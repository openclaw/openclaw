export type MatrixResolvedConfig = {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
};

/**
 * Authenticated Matrix configuration.
 * Note: deviceId is NOT included here because it's implicit in the accessToken.
 * Crypto storage (E2EE device keys) is persisted under a stable path per account
 * so it survives access token rotation; see resolveMatrixStoragePaths in storage.ts.
 */
export type MatrixAuth = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
};

export type MatrixStoragePaths = {
  rootDir: string;
  storagePath: string;
  cryptoPath: string;
  metaPath: string;
  accountKey: string;
  tokenHash: string;
};
