// Whatsapp plugin module implements channel behavior.
import {
  startWebLoginWithQr as startWebLoginWithQrImpl,
  waitForWebLogin as waitForWebLoginImpl,
} from "../login-qr-runtime.js";
import { getActiveWebListener } from "./active-listener.js";
import {
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
import { monitorWebChannel } from "./auto-reply/monitor.js";
import { loginWeb } from "./login.js";
import { whatsappSetupWizard as whatsappSetupWizardImpl } from "./setup-surface.js";

export {
  getActiveWebListener,
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
  loginWeb,
  monitorWebChannel,
};

type StartWebLoginWithQr = typeof import("../login-qr-runtime.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("../login-qr-runtime.js").waitForWebLogin;
type WhatsAppSetupWizard = typeof import("./setup-surface.js").whatsappSetupWizard;

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
