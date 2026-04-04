import type {
  credentialsMatchConfig as credentialsMatchConfigType,
  loadMatrixCredentials as loadMatrixCredentialsType,
  saveMatrixCredentials as saveMatrixCredentialsType,
  touchMatrixCredentials as touchMatrixCredentialsType,
} from "./credentials.js";

let matrixCredentialsRuntimePromise: Promise<typeof import("./credentials.js")> | undefined;

async function loadMatrixCredentialsRuntime() {
  matrixCredentialsRuntimePromise ??= import("./credentials.js");
  return matrixCredentialsRuntimePromise;
}

export async function loadMatrixCredentialRuntime(): Promise<{
  loadMatrixCredentials: typeof loadMatrixCredentialsType;
  saveMatrixCredentials: typeof saveMatrixCredentialsType;
  credentialsMatchConfig: typeof credentialsMatchConfigType;
  touchMatrixCredentials: typeof touchMatrixCredentialsType;
}> {
  const runtime = await loadMatrixCredentialsRuntime();
  return {
    loadMatrixCredentials: runtime.loadMatrixCredentials,
    saveMatrixCredentials: runtime.saveMatrixCredentials,
    credentialsMatchConfig: runtime.credentialsMatchConfig,
    touchMatrixCredentials: runtime.touchMatrixCredentials,
  };
}
