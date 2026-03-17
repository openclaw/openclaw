import { DisconnectReason } from "@whiskeysockets/baileys";
import { formatCliCommand } from "../../../src/cli/command-format.js";
import { loadConfig } from "../../../src/config/config.js";
import { danger, info, success } from "../../../src/globals.js";
import { logInfo } from "../../../src/logger.js";
import { defaultRuntime } from "../../../src/runtime.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { createWaSocket, formatError, logoutWeb, waitForWaConnection } from "./session.js";
async function loginWeb(verbose, waitForConnection, runtime = defaultRuntime, accountId) {
  const wait = waitForConnection ?? waitForWaConnection;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const sock = await createWaSocket(true, verbose, {
    authDir: account.authDir
  });
  logInfo("Waiting for WhatsApp connection...", runtime);
  try {
    await wait(sock);
    console.log(success("\u2705 Linked! Credentials saved for future sends."));
  } catch (err) {
    const code = err?.error?.output?.statusCode ?? err?.output?.statusCode;
    if (code === 515) {
      console.log(
        info(
          "WhatsApp asked for a restart after pairing (code 515); creds are saved. Restarting connection once\u2026"
        )
      );
      try {
        sock.ws?.close();
      } catch {
      }
      const retry = await createWaSocket(false, verbose, {
        authDir: account.authDir
      });
      try {
        await wait(retry);
        console.log(success("\u2705 Linked after restart; web session ready."));
        return;
      } finally {
        setTimeout(() => retry.ws?.close(), 500);
      }
    }
    if (code === DisconnectReason.loggedOut) {
      await logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime
      });
      console.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`
        )
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", { cause: err });
    }
    const formatted = formatError(err);
    console.error(danger(`WhatsApp Web connection ended before fully opening. ${formatted}`));
    throw new Error(formatted, { cause: err });
  } finally {
    setTimeout(() => {
      try {
        sock.ws?.close();
      } catch {
      }
    }, 500);
  }
}
export {
  loginWeb
};
