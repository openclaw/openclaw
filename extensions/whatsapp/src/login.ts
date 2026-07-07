// Whatsapp plugin module implements login behavior.
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
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
import { resolveWhatsAppSocketTiming } from "./socket-timing.js";

const QR_LINK_INSTRUCTION = "Open the WhatsApp app, go to Linked Devices, then scan this QR:";
const CLEAR_TERMINAL = "\x1b[2J\x1b[H";
const MIN_PAIRING_PHONE_DIGITS = 6;
const MAX_PAIRING_PHONE_DIGITS = 15;
const PHONE_CODE_PAIRING_WINDOW_MS = 5 * 60_000;

type LoginSocket = Awaited<ReturnType<typeof createWaSocket>>;

export function normalizeWhatsAppPairingPhoneNumber(phoneNumber: string): string {
  if (/\(\s*0\s*\)/.test(phoneNumber)) {
    throw new Error(
      "WhatsApp phone-code login phone number must omit optional trunk prefixes like (0).",
    );
  }
  const normalized = normalizeE164(phoneNumber);
  const digits = normalized?.replace(/\D/g, "") ?? "";
  if (digits.length < MIN_PAIRING_PHONE_DIGITS || digits.length > MAX_PAIRING_PHONE_DIGITS) {
    throw new Error(
      "WhatsApp phone-code login requires --phone-number with country code and 6-15 digits.",
    );
  }
  return digits;
}

function formatPairingCode(code: string): string {
  const trimmed = code.trim();
  return trimmed.length === 8 ? `${trimmed.slice(0, 4)} ${trimmed.slice(4)}` : trimmed;
}

function isRegisteredLoginSocket(sock: LoginSocket): boolean {
  const candidate = sock as unknown as { authState?: { creds?: { registered?: unknown } } };
  return candidate.authState?.creds?.registered === true;
}

function createWhatsAppPairingCodeReadySignal(timeoutMs: number): {
  onQr: () => void;
  reset: () => void;
  wait: (sock: LoginSocket) => Promise<void>;
} {
  let ready = false;
  return {
    onQr: () => {
      ready = true;
    },
    reset: () => {
      ready = false;
    },
    wait: (sock) =>
      new Promise<void>((resolve, reject) => {
        if (ready) {
          resolve();
          return;
        }
        const evWithOff = sock.ev as {
          on: (event: string, listener: (...args: unknown[]) => void) => void;
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
        const timer = setTimeout(onTimeout, timeoutMs);
        function cleanup() {
          clearTimeout(timer);
          evWithOff.off?.("connection.update", handler);
        }
        function finish() {
          ready = true;
          cleanup();
          resolve();
        }
        function handler(...args: unknown[]) {
          const update = (args[0] ?? {}) as Partial<import("baileys").ConnectionState>;
          if (update.qr) {
            finish();
            return;
          }
          if (update.connection === "close") {
            cleanup();
            reject(update.lastDisconnect?.error ?? new Error("Connection closed before pairing."));
          }
        }
        function onTimeout() {
          cleanup();
          reject(new Error("Timed out waiting for WhatsApp to offer phone-code pairing."));
        }
        evWithOff.on("connection.update", handler);
        if (ready) {
          finish();
        }
      }),
  };
}

function waitForWhatsAppPairingCodeReady(
  signal: ReturnType<typeof createWhatsAppPairingCodeReadySignal>,
  sock: LoginSocket,
): Promise<void> {
  return signal.wait(sock);
}

type CredentialPersistenceFailure = { error: unknown };

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
  options?: { beforeCredentialPersistence?: () => Promise<void> },
) {
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const socketTiming = resolveWhatsAppSocketTiming(cfg);
  await clearStalePhoneCodePairingAuthIfNeeded({
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    runtime,
  });
  const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir, {
    beforeCredentialPersistence: options?.beforeCredentialPersistence,
  });
  const credentialPersistenceState: { failure: CredentialPersistenceFailure | null } = {
    failure: null,
  };
  let resolveCredentialPersistenceFailure = (_failure: CredentialPersistenceFailure) => {};
  const credentialPersistenceFailurePromise = new Promise<CredentialPersistenceFailure>(
    (resolve) => {
      resolveCredentialPersistenceFailure = resolve;
    },
  );
  const onCredentialPersistenceError = (error: unknown) => {
    if (credentialPersistenceState.failure) {
      return;
    }
    credentialPersistenceState.failure = { error };
    resolveCredentialPersistenceFailure(credentialPersistenceState.failure);
  };
  const credentialPersistenceTasks = new Set<Promise<unknown>>();
  const onCredentialPersistenceTask = (task: Promise<unknown>) => {
    credentialPersistenceTasks.add(task);
    void task.then(
      () => credentialPersistenceTasks.delete(task),
      () => credentialPersistenceTasks.delete(task),
    );
  };
  const waitForCredentialPersistence = async () => {
    // Baileys schedules the final LID key write on nextTick after reporting open.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    while (credentialPersistenceTasks.size > 0) {
      await Promise.allSettled(credentialPersistenceTasks);
    }
  };
  const credentialPersistenceOptions = options?.beforeCredentialPersistence
    ? {
        beforeCredentialPersistence: async () => {
          try {
            await options.beforeCredentialPersistence?.();
          } catch (error) {
            onCredentialPersistenceError(error);
            throw error;
          }
        },
        onCredentialPersistenceError,
        onCredentialPersistenceTask,
      }
    : {};
  let qrVersion = 0;
  const onQr = (qr: string) => {
    const currentQrVersion = ++qrVersion;
    void renderQrTerminal(qr, { small: true })
      .then((output) => {
        if (currentQrVersion !== qrVersion) {
          return;
        }
        const refreshPrefix = currentQrVersion > 1 && process.stdout.isTTY ? CLEAR_TERMINAL : "";
        const renderedQr = output.endsWith("\n") ? output.slice(0, -1) : output;
        runtime.log(`${refreshPrefix}${QR_LINK_INSTRUCTION}\n${renderedQr}`);
      })
      .catch((err: unknown) => {
        if (currentQrVersion !== qrVersion) {
          return;
        }
        runtime.error(`failed rendering WhatsApp QR: ${String(err)}`);
      });
  };
  let sock = await createWaSocket(false, verbose, {
    authDir: account.authDir,
    ...socketTiming,
    onQr,
    ...credentialPersistenceOptions,
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
      ...credentialPersistenceOptions,
      ...(options?.beforeCredentialPersistence
        ? {
            credentialPersistenceFailure: credentialPersistenceFailurePromise,
            getCredentialPersistenceFailure: () => credentialPersistenceState.failure,
            waitForCredentialPersistence,
          }
        : {}),
      onSocketReplaced: (replacementSock) => {
        sock = replacementSock;
      },
    });
    if (credentialPersistenceState.failure) {
      throw credentialPersistenceState.failure.error;
    }
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
  const pairingPhoneNumber = normalizeWhatsAppPairingPhoneNumber(phoneNumber);
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const socketTiming = resolveWhatsAppSocketTiming(cfg);
  await clearStalePhoneCodePairingAuthIfNeeded({
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    runtime,
  });
  const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir);
  const pairingReadyTimeoutMs = Math.max(
    socketTiming.connectTimeoutMs ?? 0,
    PHONE_CODE_PAIRING_WINDOW_MS,
  );
  const readySignal = createWhatsAppPairingCodeReadySignal(pairingReadyTimeoutMs);
  readySignal.reset();
  let sock = await createWaSocket(false, verbose, {
    authDir: account.authDir,
    ...socketTiming,
    onQr: readySignal.onQr,
  });
  try {
    const result = await waitForWhatsAppLoginResult({
      sock,
      authDir: account.authDir,
      isLegacyAuthDir: account.isLegacyAuthDir,
      verbose,
      runtime,
      waitForConnection,
      socketTiming,
      onQr: readySignal.onQr,
      beforeCreateLoginSocket: async () => {
        readySignal.reset();
        await clearStalePhoneCodePairingAuthIfNeeded({
          authDir: account.authDir,
          isLegacyAuthDir: account.isLegacyAuthDir,
          runtime,
        });
      },
      prepareLoginSocket: async (loginSock, context) => {
        if (context.reason === "post-pairing") {
          return;
        }
        if (isRegisteredLoginSocket(loginSock)) {
          if (context.reason === "initial") {
            logInfo("Existing WhatsApp credentials found; waiting for connection...", runtime);
          }
          return;
        }
        await waitForWhatsAppPairingCodeReady(readySignal, loginSock);
        const code = await loginSock.requestPairingCode(pairingPhoneNumber);
        runtime.log(success(`WhatsApp pairing code: ${formatPairingCode(code)}`));
        runtime.log(
          "On your phone, open WhatsApp > Linked Devices > Link with phone number, then enter this code.",
        );
      },
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
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login --channel whatsapp --phone-number <number>")} and link again.`,
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
