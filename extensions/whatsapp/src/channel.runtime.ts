export { getActiveWebListener } from "./active-listener.js";
export {
  getWebAuthAgeMs,
  logWebSelfId,
  logoutWeb,
  readWebSelfId,
  webAuthExists,
} from "./auth-store.js";
export { loginWeb } from "./login.js";
export { startWebLoginWithQr, waitForWebLogin } from "./login-qr.js";
export { whatsappSetupWizard } from "./setup-surface.js";
import { monitorWebChannel as monitorWebChannelImpl } from "openclaw/plugin-sdk/whatsapp";

type MonitorWebChannel = typeof import("openclaw/plugin-sdk/whatsapp").monitorWebChannel;

export async function monitorWebChannel(
  ...args: Parameters<MonitorWebChannel>
): ReturnType<MonitorWebChannel> {
  return await monitorWebChannelImpl(...args);
}
