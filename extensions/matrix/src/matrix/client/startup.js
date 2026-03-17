const MATRIX_CLIENT_STARTUP_GRACE_MS = 2e3;
async function startMatrixClientWithGrace(params) {
  const graceMs = params.graceMs ?? MATRIX_CLIENT_STARTUP_GRACE_MS;
  let startFailed = false;
  let startError = void 0;
  let startPromise;
  try {
    startPromise = params.client.start();
  } catch (err) {
    params.onError?.(err);
    throw err;
  }
  void startPromise.catch((err) => {
    startFailed = true;
    startError = err;
    params.onError?.(err);
  });
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (startFailed) {
    throw startError;
  }
}
export {
  MATRIX_CLIENT_STARTUP_GRACE_MS,
  startMatrixClientWithGrace
};
