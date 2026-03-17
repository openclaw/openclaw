import { randomUUID } from "node:crypto";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { loadConfig } from "../../../src/config/config.js";
import { danger, info, success } from "../../../src/globals.js";
import { logInfo } from "../../../src/logger.js";
import { defaultRuntime } from "../../../src/runtime.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { renderQrPngBase64 } from "./qr-image.js";
import {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  readWebSelfId,
  waitForWaConnection,
  webAuthExists
} from "./session.js";
const ACTIVE_LOGIN_TTL_MS = 3 * 6e4;
const activeLogins = /* @__PURE__ */ new Map();
function closeSocket(sock) {
  try {
    sock.ws?.close();
  } catch {
  }
}
async function resetActiveLogin(accountId, reason) {
  const login = activeLogins.get(accountId);
  if (login) {
    closeSocket(login.sock);
    activeLogins.delete(accountId);
  }
  if (reason) {
    logInfo(reason);
  }
}
function isLoginFresh(login) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}
function attachLoginWaiter(accountId, login) {
  login.waitPromise = waitForWaConnection(login.sock).then(() => {
    const current = activeLogins.get(accountId);
    if (current?.id === login.id) {
      current.connected = true;
    }
  }).catch((err) => {
    const current = activeLogins.get(accountId);
    if (current?.id !== login.id) {
      return;
    }
    current.error = formatError(err);
    current.errorStatus = getStatusCode(err);
  });
}
async function restartLoginSocket(login, runtime) {
  if (login.restartAttempted) {
    return false;
  }
  login.restartAttempted = true;
  runtime.log(
    info("WhatsApp asked for a restart after pairing (code 515); retrying connection once\u2026")
  );
  closeSocket(login.sock);
  try {
    const sock = await createWaSocket(false, login.verbose, {
      authDir: login.authDir
    });
    login.sock = sock;
    login.connected = false;
    login.error = void 0;
    login.errorStatus = void 0;
    attachLoginWaiter(login.accountId, login);
    return true;
  } catch (err) {
    login.error = formatError(err);
    login.errorStatus = getStatusCode(err);
    return false;
  }
}
async function startWebLoginWithQr(opts = {}) {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const hasWeb = await webAuthExists(account.authDir);
  const selfId = readWebSelfId(account.authDir);
  if (hasWeb && !opts.force) {
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    return {
      message: `WhatsApp is already linked (${who}). Say \u201Crelink\u201D if you want a fresh QR.`
    };
  }
  const existing = activeLogins.get(account.accountId);
  if (existing && isLoginFresh(existing) && existing.qrDataUrl) {
    return {
      qrDataUrl: existing.qrDataUrl,
      message: "QR already active. Scan it in WhatsApp \u2192 Linked Devices."
    };
  }
  await resetActiveLogin(account.accountId);
  let resolveQr = null;
  let rejectQr = null;
  const qrPromise = new Promise((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });
  const qrTimer = setTimeout(
    () => {
      rejectQr?.(new Error("Timed out waiting for WhatsApp QR"));
    },
    Math.max(opts.timeoutMs ?? 3e4, 5e3)
  );
  let sock;
  let pendingQr = null;
  try {
    sock = await createWaSocket(false, Boolean(opts.verbose), {
      authDir: account.authDir,
      onQr: (qr2) => {
        if (pendingQr) {
          return;
        }
        pendingQr = qr2;
        const current = activeLogins.get(account.accountId);
        if (current && !current.qr) {
          current.qr = qr2;
        }
        clearTimeout(qrTimer);
        runtime.log(info("WhatsApp QR received."));
        resolveQr?.(qr2);
      }
    });
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to start WhatsApp login: ${String(err)}`
    };
  }
  const login = {
    accountId: account.accountId,
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    id: randomUUID(),
    sock,
    startedAt: Date.now(),
    connected: false,
    waitPromise: Promise.resolve(),
    restartAttempted: false,
    verbose: Boolean(opts.verbose)
  };
  activeLogins.set(account.accountId, login);
  if (pendingQr && !login.qr) {
    login.qr = pendingQr;
  }
  attachLoginWaiter(account.accountId, login);
  let qr;
  try {
    qr = await qrPromise;
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to get QR: ${String(err)}`
    };
  }
  const base64 = await renderQrPngBase64(qr);
  login.qrDataUrl = `data:image/png;base64,${base64}`;
  return {
    qrDataUrl: login.qrDataUrl,
    message: "Scan this QR in WhatsApp \u2192 Linked Devices."
  };
}
async function waitForWebLogin(opts = {}) {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const activeLogin = activeLogins.get(account.accountId);
  if (!activeLogin) {
    return {
      connected: false,
      message: "No active WhatsApp login in progress."
    };
  }
  const login = activeLogin;
  if (!isLoginFresh(login)) {
    await resetActiveLogin(account.accountId);
    return {
      connected: false,
      message: "The login QR expired. Ask me to generate a new one."
    };
  }
  const timeoutMs = Math.max(opts.timeoutMs ?? 12e4, 1e3);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you\u2019ve scanned it."
      };
    }
    const timeout = new Promise(
      (resolve) => setTimeout(() => resolve("timeout"), remaining)
    );
    const result = await Promise.race([login.waitPromise.then(() => "done"), timeout]);
    if (result === "timeout") {
      return {
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you\u2019ve scanned it."
      };
    }
    if (login.error) {
      if (login.errorStatus === DisconnectReason.loggedOut) {
        await logoutWeb({
          authDir: login.authDir,
          isLegacyAuthDir: login.isLegacyAuthDir,
          runtime
        });
        const message2 = "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";
        await resetActiveLogin(account.accountId, message2);
        runtime.log(danger(message2));
        return { connected: false, message: message2 };
      }
      if (login.errorStatus === 515) {
        const restarted = await restartLoginSocket(login, runtime);
        if (restarted && isLoginFresh(login)) {
          continue;
        }
      }
      const message = `WhatsApp login failed: ${login.error}`;
      await resetActiveLogin(account.accountId, message);
      runtime.log(danger(message));
      return { connected: false, message };
    }
    if (login.connected) {
      const message = "\u2705 Linked! WhatsApp is ready.";
      runtime.log(success(message));
      await resetActiveLogin(account.accountId);
      return { connected: true, message };
    }
    return { connected: false, message: "Login ended without a connection." };
  }
}
export {
  startWebLoginWithQr,
  waitForWebLogin
};
