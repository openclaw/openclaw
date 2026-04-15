import {
  startWebLoginWithQr as startWebLoginWithQrImpl,
  waitForWebLogin as waitForWebLoginImpl,
} from "../login-qr-runtime.js";
import {
  getWebAuthAgeMs as getWebAuthAgeMsImpl,
  logWebSelfId as logWebSelfIdImpl,
  logoutWeb as logoutWebImpl,
  readWebSelfId as readWebSelfIdImpl,
  webAuthExists as webAuthExistsImpl,
} from "./auth-store.js";

// Lazy-load the heavy WhatsApp runtime modules to keep Baileys out of the
// root dist static import graph.  These are only needed at runtime when
// a WhatsApp channel operation is actually invoked.
type LoginWeb = typeof import("./login.js").loginWeb;
function loadLoginWeb(): Promise<typeof import("./login.js")> {
  return import("./login.js");
}

type GetActiveWebListener = typeof import("./active-listener.js").getActiveWebListener;
function loadActiveListener(): Promise<typeof import("./active-listener.js")> {
  return import("./active-listener.js");
}

type WhatsAppSetupWizard = typeof import("./setup-surface.js").whatsappSetupWizard;
function loadSetupSurface(): Promise<typeof import("./setup-surface.js")> {
  return import("./setup-surface.js");
}

type MonitorWebChannel = typeof import("./auto-reply/monitor.js").monitorWebChannel;
function loadMonitor(): Promise<typeof import("./auto-reply/monitor.js")> {
  return import("./auto-reply/monitor.js");
}

type GetWebAuthAgeMs = typeof import("./auth-store.js").getWebAuthAgeMs;
type LogWebSelfId = typeof import("./auth-store.js").logWebSelfId;
type LogoutWeb = typeof import("./auth-store.js").logoutWeb;
type ReadWebSelfId = typeof import("./auth-store.js").readWebSelfId;
type WebAuthExists = typeof import("./auth-store.js").webAuthExists;
type StartWebLoginWithQr = typeof import("../login-qr-runtime.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("../login-qr-runtime.js").waitForWebLogin;

export function getActiveWebListener(
  ...args: Parameters<GetActiveWebListener>
): ReturnType<GetActiveWebListener> {
  // getActiveWebListener is a thin wrapper; call it directly to preserve sync API.
  // The heavy Baileys chain lives inside the returned listener object, not in this
  // function's own static imports.
  return import("./active-listener.js").then(
    (m) => m.getActiveWebListener(...args),
    (err) => {
      // Re-throw as a clean error without leaking internal paths.
      throw new Error("getActiveWebListener unavailable: " + String(err));
    },
  ) as ReturnType<GetActiveWebListener>;
}

export function getWebAuthAgeMs(...args: Parameters<GetWebAuthAgeMs>): ReturnType<GetWebAuthAgeMs> {
  return getWebAuthAgeMsImpl(...args);
}

export function logWebSelfId(...args: Parameters<LogWebSelfId>): ReturnType<LogWebSelfId> {
  return logWebSelfIdImpl(...args);
}

export function logoutWeb(...args: Parameters<LogoutWeb>): ReturnType<LogoutWeb> {
  return logoutWebImpl(...args);
}

export function readWebSelfId(...args: Parameters<ReadWebSelfId>): ReturnType<ReadWebSelfId> {
  return readWebSelfIdImpl(...args);
}

export function webAuthExists(...args: Parameters<WebAuthExists>): ReturnType<WebAuthExists> {
  return webAuthExistsImpl(...args);
}

export async function loginWeb(
  ...args: Parameters<LoginWeb>
): ReturnType<LoginWeb> {
  const { loginWeb: loginWebImpl } = await loadLoginWeb();
  return await loginWebImpl(...args);
}

export async function startWebLoginWithQr(
  ...args: Parameters<StartWebLoginWithQr>
): ReturnType<StartWebLoginWithQr> {
  return await startWebLoginWithQrImpl(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WaitForWebLogin>
): ReturnType<WaitForLogin> {
  return await waitForWebLoginImpl(...args);
}

export async function whatsappSetupWizard(
  ...args: Parameters<WhatsAppSetupWizard>
): ReturnType<WhatsAppSetupWizard> {
  const { whatsappSetupWizard: impl } = await loadSetupSurface();
  return impl(...args);
}

export async function monitorWebChannel(
  ...args: Parameters<MonitorWebChannel>
): ReturnType<MonitorWebChannel> {
  const { monitorWebChannel: fn } = await loadMonitor();
  return await fn(...args);
}
