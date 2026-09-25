import {
  preflightWebLoginWithQrStart as preflightWebLoginWithQrStartImpl,
  startWebLoginWithQr as startWebLoginWithQrImpl,
  waitForWebLogin as waitForWebLoginImpl,
} from "../login-qr-runtime.js";
import "./active-listener.js";
import "./auth-store.js";
import "./auto-reply/monitor.js";
import "./login.js";
import { whatsappSetupWizard as whatsappSetupWizardImpl } from "./setup-surface.js";
export { getActiveWebListener } from "./active-listener.js";
export {
  getWebAuthAgeMs,
  logWebSelfId,
  logoutWeb,
  readWebAuthSnapshot,
  readWebAuthState,
  readWebAuthExistsBestEffort,
  readWebAuthExistsForDecision,
  readWebAuthSnapshotBestEffort,
  readWebSelfId,
  webAuthExists,
} from "./auth-store.js";
export { monitorWebChannel } from "./auto-reply/monitor.js";
export { loginWeb } from "./login.js";

type PreflightWebLoginWithQrStart =
  typeof import("../login-qr-runtime.js").preflightWebLoginWithQrStart;
type StartWebLoginWithQr = typeof import("../login-qr-runtime.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("../login-qr-runtime.js").waitForWebLogin;
type WhatsAppSetupWizard = typeof import("./setup-surface.js").whatsappSetupWizard;

export async function preflightWebLoginWithQrStart(
  ...args: Parameters<PreflightWebLoginWithQrStart>
): ReturnType<PreflightWebLoginWithQrStart> {
  return await preflightWebLoginWithQrStartImpl(...args);
}

export async function startWebLoginWithQr(
  ...args: Parameters<StartWebLoginWithQr>
): ReturnType<StartWebLoginWithQr> {
  return await startWebLoginWithQrImpl(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WaitForWebLogin>
): ReturnType<WaitForWebLogin> {
  return await waitForWebLoginImpl(...args);
}

export const whatsappSetupWizard: WhatsAppSetupWizard = { ...whatsappSetupWizardImpl };
