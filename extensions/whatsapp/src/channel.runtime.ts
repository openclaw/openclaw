import "./active-listener.js";
import "./auth-store.js";
import "./auto-reply/monitor.js";
import "./login.js";
import { whatsappSetupWizard as whatsappSetupWizardImpl } from "./setup-surface.js";
export { startWebLoginWithQr, waitForWebLogin } from "../login-qr-runtime.js";
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

type WhatsAppSetupWizard = typeof import("./setup-surface.js").whatsappSetupWizard;

export const whatsappSetupWizard: WhatsAppSetupWizard = { ...whatsappSetupWizardImpl };
