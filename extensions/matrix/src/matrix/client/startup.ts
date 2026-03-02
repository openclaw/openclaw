import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

export const MATRIX_CLIENT_STARTUP_GRACE_MS = 2000;

export async function startMatrixClientWithGrace(params: {
  client: Pick<MatrixClient, "start">;
  graceMs?: number;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const graceMs = params.graceMs ?? MATRIX_CLIENT_STARTUP_GRACE_MS;
  let startFailed = false;
  let startError: unknown = undefined;
  let startPromise: Promise<unknown>;
  try {
    startPromise = params.client.start();
  } catch (err) {
    params.onError?.(err);
    throw err;
  }
  void startPromise.catch((err: unknown) => {
    startFailed = true;
    startError = err;
    params.onError?.(err);
  });
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (startFailed) {
    throw startError;
  }
}
