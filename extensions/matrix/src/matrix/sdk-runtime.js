import { createRequire } from "node:module";
let cachedMatrixSdkRuntime = null;
function loadMatrixSdk() {
  if (cachedMatrixSdkRuntime) {
    return cachedMatrixSdkRuntime;
  }
  const req = createRequire(import.meta.url);
  cachedMatrixSdkRuntime = req("@vector-im/matrix-bot-sdk");
  return cachedMatrixSdkRuntime;
}
function getMatrixLogService() {
  return loadMatrixSdk().LogService;
}
export {
  getMatrixLogService,
  loadMatrixSdk
};
