import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logInfo } from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { closeWaSocketSoon, waitForWhatsAppLoginResult } from "./connection-controller.js";

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
  createSocket?: (verbose: boolean, v: boolean, opts: { authDir: string }) => Promise<unknown>,
) {
  const { createWaSocket: _create, waitForWaConnection: _wait } = await import("./session.js");
  const _createSocket = createSocket ?? _create;
  const waitForConn = waitForConnection ?? _wait;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  let sock = await _createSocket(true, verbose, {
    authDir: account.authDir,
  });
  logInfo("Waiting for WhatsApp connection...", runtime);
  try {
    const result = await waitForWhatsAppLoginResult({
      sock,
      authDir: account.authDir,
      isLegacyAuthDir: account.isLegacyAuthDir,
      verbose,
      runtime,
      waitForConnection: waitForConn,
      createSocket: _createSocket,
      onSocketReplaced: (replacementSock) => {
        sock = replacementSock;
      },
    });
    if (result.outcome === "connected") {
      console.log(
        success(
          result.restarted
            ? "✅ Linked after restart; web session ready."
            : "✅ Linked! Credentials saved for future sends.",
        ),
      );
      return;
    }

    if (result.outcome === "logged-out") {
      console.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`,
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", {
        cause: result.error,
      });
    }

    console.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
    throw new Error(result.message, { cause: result.error });
  } finally {
    // Let Baileys flush any final events before closing the socket.
    closeWaSocketSoon(sock);
  }
}
