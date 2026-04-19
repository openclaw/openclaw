type ReadExistingWebLoginWithQrResult =
  typeof import("./src/login-qr.js").readExistingWebLoginWithQrResult;
type PreflightWebLoginWithQrStart = typeof import("./src/login-qr.js").preflightWebLoginWithQrStart;
type StartWebLoginWithQrAfterPreflight =
  typeof import("./src/login-qr.js").startWebLoginWithQrAfterPreflight;
type StartWebLoginWithQr = typeof import("./src/login-qr.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("./src/login-qr.js").waitForWebLogin;

let loginQrModulePromise: Promise<typeof import("./src/login-qr.js")> | null = null;

function loadLoginQrModule() {
  loginQrModulePromise ??= import("./src/login-qr.js");
  return loginQrModulePromise;
}

export async function preflightWebLoginWithQrStart(
  ...args: Parameters<PreflightWebLoginWithQrStart>
): ReturnType<PreflightWebLoginWithQrStart> {
  const { preflightWebLoginWithQrStart } = await loadLoginQrModule();
  return await preflightWebLoginWithQrStart(...args);
}

export async function readExistingWebLoginWithQrResult(
  ...args: Parameters<ReadExistingWebLoginWithQrResult>
): Promise<ReturnType<ReadExistingWebLoginWithQrResult>> {
  const { readExistingWebLoginWithQrResult } = await loadLoginQrModule();
  return readExistingWebLoginWithQrResult(...args);
}

export async function startWebLoginWithQr(
  ...args: Parameters<StartWebLoginWithQr>
): ReturnType<StartWebLoginWithQr> {
  const { startWebLoginWithQr } = await loadLoginQrModule();
  return await startWebLoginWithQr(...args);
}

export async function startWebLoginWithQrAfterPreflight(
  ...args: Parameters<StartWebLoginWithQrAfterPreflight>
): ReturnType<StartWebLoginWithQrAfterPreflight> {
  const { startWebLoginWithQrAfterPreflight } = await loadLoginQrModule();
  return await startWebLoginWithQrAfterPreflight(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WaitForWebLogin>
): ReturnType<WaitForWebLogin> {
  const { waitForWebLogin } = await loadLoginQrModule();
  return await waitForWebLogin(...args);
}
