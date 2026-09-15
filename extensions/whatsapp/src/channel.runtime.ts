// Whatsapp plugin module implements channel behavior.
import {
  preflightWebLoginWithQrStart as preflightWebLoginWithQrStartImpl,
  readExistingWebLoginWithQrResult as readExistingWebLoginWithQrResultImpl,
  startWebLoginWithQrAfterPreflight as startWebLoginWithQrAfterPreflightImpl,
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

type PreflightWebLoginWithQrStart =
  typeof import("../login-qr-runtime.js").preflightWebLoginWithQrStart;
type ReadExistingWebLoginWithQrResult =
  typeof import("../login-qr-runtime.js").readExistingWebLoginWithQrResult;
type StartWebLoginWithQrAfterPreflight =
  typeof import("../login-qr-runtime.js").startWebLoginWithQrAfterPreflight;
type StartWebLoginWithQr = typeof import("../login-qr-runtime.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("../login-qr-runtime.js").waitForWebLogin;
type WhatsAppSetupWizard = typeof import("./setup-surface.js").whatsappSetupWizard;

export async function preflightWebLoginWithQrStart(
  ...args: Parameters<PreflightWebLoginWithQrStart>
): ReturnType<PreflightWebLoginWithQrStart> {
  return await preflightWebLoginWithQrStartImpl(...args);
}

export async function readExistingWebLoginWithQrResult(
  ...args: Parameters<ReadExistingWebLoginWithQrResult>
): Promise<Awaited<ReturnType<ReadExistingWebLoginWithQrResult>>> {
  return await readExistingWebLoginWithQrResultImpl(...args);
}

export async function startWebLoginWithQr(
  ...args: Parameters<StartWebLoginWithQr>
): ReturnType<StartWebLoginWithQr> {
  return await startWebLoginWithQrImpl(...args);
}

export async function startWebLoginWithQrAfterPreflight(
  ...args: Parameters<StartWebLoginWithQrAfterPreflight>
): ReturnType<StartWebLoginWithQrAfterPreflight> {
  return await startWebLoginWithQrAfterPreflightImpl(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WaitForWebLogin>
): ReturnType<WaitForWebLogin> {
  return await waitForWebLoginImpl(...args);
}

export const whatsappSetupWizard: WhatsAppSetupWizard = { ...whatsappSetupWizardImpl };
