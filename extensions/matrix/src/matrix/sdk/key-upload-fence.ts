import type { MatrixSnapshotStateRuntime } from "../crypto-state-store.js";

type CryptoRuntime = Pick<typeof import("./crypto-runtime.js"), "persistCryptoBeforeKeyUpload">;

export async function persistMatrixKeyUploadIfNeeded(params: {
  resource: RequestInfo | URL;
  init?: RequestInit;
  encryptionEnabled: boolean;
  snapshotPath?: string;
  databasePrefix?: string;
  stateRuntime?: MatrixSnapshotStateRuntime;
  assertClientActive: () => void;
  requestAuthority?: () => void;
  requestSignal?: AbortSignal;
  loadCryptoRuntime: () => Promise<CryptoRuntime>;
}): Promise<void> {
  const { resource, init } = params;
  const method = init?.method ?? (resource instanceof Request ? resource.method : "GET");
  const url = resource instanceof Request ? resource.url : String(resource);
  if (
    !params.encryptionEnabled ||
    method.toUpperCase() !== "POST" ||
    !/\/_matrix\/client\/(?:v3|r0|unstable)\/keys\/upload$/.test(new URL(url).pathname)
  ) {
    return;
  }
  const requestAuthority = params.requestAuthority;
  const requestSignals = [
    init?.signal ?? (resource instanceof Request ? resource.signal : undefined),
    params.requestSignal,
  ];
  const assertCurrent = () => {
    params.assertClientActive();
    requestAuthority?.();
    for (const signal of requestSignals) {
      signal?.throwIfAborted();
    }
  };
  assertCurrent();
  const runtime = await params.loadCryptoRuntime();
  assertCurrent();
  await runtime.persistCryptoBeforeKeyUpload({
    resource,
    init,
    snapshotPath: params.snapshotPath,
    databasePrefix: params.databasePrefix,
    stateRuntime: params.stateRuntime,
    authority: { assertCurrent },
  });
  assertCurrent();
}
