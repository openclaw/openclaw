import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Whatsapp plugin module implements login qr runtime behavior.
type StartWebLoginWithQr = typeof import("./src/login-qr.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("./src/login-qr.js").waitForWebLogin;

const loadLoginQrModule = createLazyRuntimeModule(() => import("./src/login-qr.js"));

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
  const { startWebLoginWithQr: startWebLoginWithQrLocal } = await loadLoginQrModule();
  return await startWebLoginWithQrLocal(...args);
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
  const { waitForWebLogin: waitForWebLoginLocal } = await loadLoginQrModule();
  return await waitForWebLoginLocal(...args);
}
