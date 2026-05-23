import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { logInfo } from "openclaw/plugin-sdk/logging-core";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "./accounts.js";
import {
  clearStalePhoneCodePairingAuthIfNeeded,
  restoreCredsFromBackupIfNeeded,
} from "./auth-store.js";
import { closeWaSocketSoon, waitForWhatsAppLoginResult } from "./connection-controller.js";
import { renderQrTerminal } from "./qr-terminal.js";
import { createWaSocket, waitForWaConnection } from "./session.js";
import { Browsers } from "./session.runtime.js";
import { resolveWhatsAppSocketTiming } from "./socket-timing.js";

const MIN_PHONE_NUMBER_DIGITS = 6;
const MAX_PHONE_NUMBER_DIGITS = 15;
const PHONE_CODE_PAIRING_WINDOW_MS = 5 * 60_000;

export function normalizeWhatsAppPairingPhoneNumber(phoneNumber: string): string {
  if (/\(\s*0\s*\)/.test(phoneNumber)) {
    throw new Error(
      "WhatsApp phone-code login phone number must omit optional trunk prefixes like (0).",
    );
  }
  const digits = phoneNumber.replace(/\D/g, "");
  if (!digits) {
    throw new Error(
      "WhatsApp phone-code login requires --phone-number with country code and digits.",
    );
  }
  if (digits.length < MIN_PHONE_NUMBER_DIGITS || digits.length > MAX_PHONE_NUMBER_DIGITS) {
    throw new Error(
      "WhatsApp phone-code login phone number must include country code and be 6-15 digits.",
    );
  }
  return digits;
}

function formatPairingCode(code: string): string {
  const trimmed = code.trim();
  return trimmed.length === 8 ? `${trimmed.slice(0, 4)} ${trimmed.slice(4)}` : trimmed;
}

function createWhatsAppPairingCodeReadySignal(timeoutMs: number): {
  onQr: () => void;
  wait: (sock: Awaited<ReturnType<typeof createWaSocket>>) => Promise<void>;
} {
  let ready = false;
  const markReady = () => {
    ready = true;
  };

  return {
    onQr: markReady,
    wait: (sock) => {
      return new Promise<void>((resolve, reject) => {
        type OffCapable = {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
        const evWithOff = sock.ev as unknown as OffCapable;
        const cleanup = () => {
          clearTimeout(timer);
          evWithOff.off?.("connection.update", handler);
        };
        const finish = () => {
          ready = true;
          cleanup();
          resolve();
        };
        const handler = (...args: unknown[]) => {
          const update = (args[0] ?? {}) as Partial<import("baileys").ConnectionState>;
          if (update.qr) {
            finish();
            return;
          }
          if (update.connection === "close") {
            cleanup();
            reject(update.lastDisconnect ?? new Error("Connection closed before pairing code."));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for WhatsApp to offer phone-code pairing."));
        }, timeoutMs);
        sock.ev.on("connection.update", handler);
        if (ready) {
          finish();
        }
      });
    },
  };
}

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
) {
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const socketTiming = resolveWhatsAppSocketTiming(cfg);
  await clearStalePhoneCodePairingAuthIfNeeded({
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    runtime,
  });
  const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir);
  const onQr = (qr: string) => {
    runtime.log("Open the WhatsApp app, go to Linked Devices, then scan this QR:");
    void renderQrTerminal(qr)
      .then((output) => {
        runtime.log(output.endsWith("\n") ? output.slice(0, -1) : output);
      })
      .catch((err) => {
        runtime.error(`failed rendering WhatsApp QR: ${String(err)}`);
      });
  };
  let sock = await createWaSocket(false, verbose, {
    authDir: account.authDir,
    ...socketTiming,
    onQr,
  });
  logInfo("Waiting for WhatsApp connection...", runtime);
  try {
    const result = await waitForWhatsAppLoginResult({
      sock,
      authDir: account.authDir,
      isLegacyAuthDir: account.isLegacyAuthDir,
      verbose,
      runtime,
      waitForConnection,
      socketTiming,
      onQr,
      onSocketReplaced: (replacementSock) => {
        sock = replacementSock;
      },
    });
    if (result.outcome === "connected") {
      runtime.log(
        success(
          result.restarted
            ? "✅ Linked after restart; web session ready."
            : restoredFromBackup
              ? "✅ Recovered from creds.json.bak; web session ready."
              : "✅ Linked! Credentials saved for future sends.",
        ),
      );
      return;
    }

    if (result.outcome === "logged-out") {
      runtime.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`,
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", {
        cause: result.error,
      });
    }

    runtime.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
    throw new Error(result.message, { cause: result.error });
  } finally {
    // Let Baileys flush any final events before closing the socket.
    closeWaSocketSoon(sock);
  }
}

export async function loginWebWithPhoneCode(
  verbose: boolean,
  phoneNumber: string,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
) {
  const normalizedPhoneNumber = normalizeWhatsAppPairingPhoneNumber(phoneNumber);
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const socketTiming = resolveWhatsAppSocketTiming(cfg);
  await clearStalePhoneCodePairingAuthIfNeeded({
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    runtime,
  });
  const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir);
  const readySignal = createWhatsAppPairingCodeReadySignal(
    Math.max(socketTiming.connectTimeoutMs ?? 0, PHONE_CODE_PAIRING_WINDOW_MS),
  );
  let sock = await createWaSocket(false, verbose, {
    authDir: account.authDir,
    browser: Browsers.macOS("Chrome"),
    ...socketTiming,
    onQr: readySignal.onQr,
    qrTimeoutMs: PHONE_CODE_PAIRING_WINDOW_MS,
  });
  try {
    if (!sock.authState.creds.registered) {
      await readySignal.wait(sock);
      const code = await sock.requestPairingCode(normalizedPhoneNumber);
      runtime.log(success(`WhatsApp pairing code: ${formatPairingCode(code)}`));
      runtime.log(
        "On your phone, open WhatsApp → Linked Devices → Link with phone number, then enter this code.",
      );
    } else {
      logInfo("Existing WhatsApp credentials found; waiting for connection...", runtime);
    }

    const result = await waitForWhatsAppLoginResult({
      sock,
      authDir: account.authDir,
      isLegacyAuthDir: account.isLegacyAuthDir,
      verbose,
      runtime,
      waitForConnection,
      socketTiming,
      onSocketReplaced: (replacementSock) => {
        sock = replacementSock;
      },
    });
    if (result.outcome === "connected") {
      runtime.log(
        success(
          result.restarted
            ? "✅ Linked after restart; web session ready."
            : restoredFromBackup
              ? "✅ Recovered from creds.json.bak; web session ready."
              : "✅ Linked with phone code! Credentials saved for future sends.",
        ),
      );
      return;
    }

    if (result.outcome === "logged-out") {
      runtime.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and link again.`,
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", {
        cause: result.error,
      });
    }

    runtime.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
    throw new Error(result.message, { cause: result.error });
  } catch (error) {
    await clearStalePhoneCodePairingAuthIfNeeded({
      authDir: account.authDir,
      isLegacyAuthDir: account.isLegacyAuthDir,
      runtime,
    });
    throw error;
  } finally {
    closeWaSocketSoon(sock);
  }
}
