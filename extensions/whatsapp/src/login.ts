// Whatsapp plugin module implements login behavior.
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { logInfo } from "openclaw/plugin-sdk/logging-core";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "./accounts.js";
import {
  isLinkedWebCredsPayload,
  prepareWebAuthForLogin,
  restoreCredsFromBackupIfNeeded,
  WhatsAppAuthUnstableError,
} from "./auth-store.js";
import { closeWaSocketSoon, waitForWhatsAppLoginResult } from "./connection-controller.js";
import { resolveComparableIdentity } from "./identity.js";
import { renderQrTerminal } from "./qr-terminal.js";
import { createWaSocket, waitForWaConnection } from "./session.js";
import { resolveWhatsAppSocketTiming } from "./socket-timing.js";

const QR_LINK_INSTRUCTION = "Open the WhatsApp app, go to Linked Devices, then scan this QR:";
const CLEAR_TERMINAL = "\x1b[2J\x1b[H";
const MAX_PAIRING_PHONE_DIGITS = 15;
const PAIRING_PHONE_INPUT_PATTERN = /^\+?[\d\s().-]+$/;
const PHONE_CODE_PAIRING_READY_TIMEOUT_MS = 5 * 60_000;

type LoginSocket = Awaited<ReturnType<typeof createWaSocket>>;

function formatWhatsAppAccountCommand(action: "login" | "logout", accountId: string): string {
  return formatCliCommand(`openclaw channels ${action} --channel whatsapp --account ${accountId}`);
}

function formatStalePhoneCodeAuthNotClearedMessage(accountId: string): string {
  return `Previous WhatsApp phone-code login left partial credentials in this auth directory, but OpenClaw could not safely clear them. Run ${formatWhatsAppAccountCommand("logout", accountId)} for managed accounts, or remove the custom auth directory's WhatsApp credentials manually, then retry login.`;
}

export function normalizeWhatsAppPairingPhoneNumber(phoneNumber: string): string {
  const input = phoneNumber.trim();
  const internationalInput = input.startsWith("+") ? input : `+${input}`;
  const parsed = PAIRING_PHONE_INPUT_PATTERN.test(input)
    ? parsePhoneNumberFromString(internationalInput, { extract: false })
    : undefined;
  const suppliedDigits = input.replace(/\D/g, "");
  const canonicalDigits = parsed?.number.slice(1) ?? "";
  // Baileys targets these exact digits, so reject parser "repairs" that remove
  // a national trunk prefix or fold an extension into a different destination.
  const preservesSuppliedDigits = suppliedDigits === canonicalDigits;
  const isCanonicalPairingNumber =
    parsed !== undefined &&
    !parsed.ext &&
    parsed.isPossible() &&
    preservesSuppliedDigits &&
    canonicalDigits.length <= MAX_PAIRING_PHONE_DIGITS;
  if (!isCanonicalPairingNumber) {
    throw new Error(
      "WhatsApp phone-code login requires an international phone number with country code and no extension or national trunk prefix.",
    );
  }
  return canonicalDigits;
}

function formatPairingCode(code: string): string {
  const trimmed = code.trim();
  return trimmed.length === 8 ? `${trimmed.slice(0, 4)} ${trimmed.slice(4)}` : trimmed;
}

function isLinkedLoginSocket(sock: LoginSocket): boolean {
  return isLinkedWebCredsPayload(sock.authState.creds);
}

function assertLinkedLoginSocketMatchesPairingPhoneNumber(
  sock: LoginSocket,
  pairingPhoneNumber: string,
  authDir: string,
  accountId: string,
): void {
  const creds = sock.authState.creds;
  const identity = resolveComparableIdentity(
    {
      jid: typeof creds?.me?.id === "string" ? creds.me.id : null,
      lid: typeof creds?.me?.lid === "string" ? creds.me.lid : null,
    },
    authDir,
  );
  const linkedPhoneNumber = identity.e164?.replace(/\D/g, "");
  if (!linkedPhoneNumber || linkedPhoneNumber === pairingPhoneNumber) {
    return;
  }
  const linkedIdentity = identity.e164 ?? identity.jid ?? identity.lid ?? "unknown";
  throw new Error(
    `Existing WhatsApp credentials are linked to ${linkedIdentity}, not +${pairingPhoneNumber}. Run ${formatWhatsAppAccountCommand("logout", accountId)} before linking a different phone number.`,
  );
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
          // Baileys emits "connecting" on the next tick before its WebSocket is
          // necessarily open. The server's pair-device QR proves sendNode is ready.
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

type CredentialPersistenceFailure = { error: unknown };

async function prepareWebAuthForLoginOrThrow(params: {
  authDir: string;
  accountId: string;
  isLegacyAuthDir: boolean;
  runtime: RuntimeEnv;
  beforeCredentialPersistence?: () => Promise<void>;
}): Promise<void> {
  const { accountId, ...authParams } = params;
  const result = await prepareWebAuthForLogin({ ...authParams, mode: "preserve-linked" });
  if (result === "unstable") {
    throw new WhatsAppAuthUnstableError();
  }
  if (result === "not-cleared") {
    throw new Error(formatStalePhoneCodeAuthNotClearedMessage(accountId));
  }
}

type WebLoginMode =
  | {
      kind: "qr";
      beforeCredentialPersistence?: () => Promise<void>;
    }
  | {
      kind: "phone-code";
      pairingPhoneNumber: string;
    };

type LoginWaitParams = Parameters<typeof waitForWhatsAppLoginResult>[0];

async function runWebLogin(
  mode: WebLoginMode,
  verbose: boolean,
  waitForConnection: typeof waitForWaConnection | undefined,
  runtime: RuntimeEnv,
  accountId: string | undefined,
): Promise<void> {
  const qrMode = mode.kind === "qr" ? mode : null;
  const phoneMode = mode.kind === "phone-code" ? mode : null;
  const beforeCredentialPersistence = qrMode?.beforeCredentialPersistence;
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const socketTiming = resolveWhatsAppSocketTiming(cfg);
  await prepareWebAuthForLoginOrThrow({
    authDir: account.authDir,
    accountId: account.accountId,
    isLegacyAuthDir: account.isLegacyAuthDir,
    runtime,
    beforeCredentialPersistence,
  });
  const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir, {
    beforeCredentialPersistence,
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
  // Persistence observation is part of login correctness for every mode.
  // The setup authority guard is an independent, optional pre-write check.
  const credentialPersistenceOptions = {
    ...(beforeCredentialPersistence ? { beforeCredentialPersistence } : {}),
    onCredentialPersistenceError,
    onCredentialPersistenceTask,
  };

  const phoneReadySignal = phoneMode
    ? createWhatsAppPairingCodeReadySignal(
        Math.max(socketTiming.connectTimeoutMs ?? 0, PHONE_CODE_PAIRING_READY_TIMEOUT_MS),
      )
    : null;
  let qrVersion = 0;
  const onQr =
    phoneReadySignal?.onQr ??
    ((qr: string) => {
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
    });

  const phoneLoginHooks: Partial<
    Pick<LoginWaitParams, "beforeCreateLoginSocket" | "prepareLoginSocket">
  > = {};
  if (phoneMode && phoneReadySignal) {
    phoneLoginHooks.beforeCreateLoginSocket = async (context) => {
      // The 515 restart completes the same pairing attempt and must reuse its saved creds.
      if (context.reason === "post-pairing") {
        return;
      }
      phoneReadySignal.reset();
      if (context.reason === "timeout") {
        await prepareWebAuthForLoginOrThrow({
          authDir: account.authDir,
          accountId: account.accountId,
          isLegacyAuthDir: account.isLegacyAuthDir,
          runtime,
        });
      }
    };
    phoneLoginHooks.prepareLoginSocket = async (loginSock, context) => {
      if (context.reason === "post-pairing") {
        return;
      }
      if (isLinkedLoginSocket(loginSock)) {
        assertLinkedLoginSocketMatchesPairingPhoneNumber(
          loginSock,
          phoneMode.pairingPhoneNumber,
          account.authDir,
          account.accountId,
        );
        if (context.reason === "initial") {
          logInfo("Existing WhatsApp credentials found; waiting for connection...", runtime);
        }
        return;
      }
      await phoneReadySignal.wait(loginSock);
      const code = await loginSock.requestPairingCode(phoneMode.pairingPhoneNumber);
      runtime.log(success(`WhatsApp pairing code: ${formatPairingCode(code)}`));
      runtime.log(
        "On your phone, open WhatsApp > Linked Devices > Link with phone number, then enter this code.",
      );
    };
  }

  let sock = await createWaSocket(false, verbose, {
    authDir: account.authDir,
    ...socketTiming,
    onQr,
    ...credentialPersistenceOptions,
  });
  if (qrMode) {
    logInfo("Waiting for WhatsApp connection...", runtime);
  }
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
      ...phoneLoginHooks,
      ...credentialPersistenceOptions,
      credentialPersistenceFailure: credentialPersistenceFailurePromise,
      getCredentialPersistenceFailure: () => credentialPersistenceState.failure,
      waitForCredentialPersistence,
      onSocketReplaced: (replacementSock) => {
        sock = replacementSock;
      },
    });
    if (credentialPersistenceState.failure) {
      throw credentialPersistenceState.failure.error;
    }
    if (result.outcome === "connected") {
      const linkedMessage = phoneMode
        ? "✅ Linked with phone code! Credentials saved for future sends."
        : "✅ Linked! Credentials saved for future sends.";
      runtime.log(
        success(
          result.restarted
            ? "✅ Linked after restart; web session ready."
            : restoredFromBackup
              ? "✅ Recovered from creds.json.bak; web session ready."
              : linkedMessage,
        ),
      );
      return;
    }

    if (result.outcome === "logged-out") {
      const loginCommand = formatWhatsAppAccountCommand("login", account.accountId);
      const relinkInstruction = phoneMode
        ? `${loginCommand}, choose phone-number linking, and link again.`
        : `${loginCommand} and scan the QR again.`;
      runtime.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${relinkInstruction}`,
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", {
        cause: result.error,
      });
    }

    runtime.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
    if (phoneMode && result.error instanceof WhatsAppAuthUnstableError) {
      throw result.error;
    }
    throw new Error(result.message, { cause: result.error });
  } catch (error) {
    if (phoneMode && !(error instanceof WhatsAppAuthUnstableError)) {
      await prepareWebAuthForLogin({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        mode: "preserve-linked",
        runtime,
      });
    }
    throw error;
  } finally {
    // Let Baileys flush any final events before closing the socket.
    closeWaSocketSoon(sock);
  }
}

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
  options?: { beforeCredentialPersistence?: () => Promise<void> },
): Promise<void> {
  await runWebLogin(
    {
      kind: "qr",
      beforeCredentialPersistence: options?.beforeCredentialPersistence,
    },
    verbose,
    waitForConnection,
    runtime,
    accountId,
  );
}

export async function loginWebWithPhoneCode(
  verbose: boolean,
  phoneNumber: string,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
): Promise<void> {
  await runWebLogin(
    {
      kind: "phone-code",
      pairingPhoneNumber: normalizeWhatsAppPairingPhoneNumber(phoneNumber),
    },
    verbose,
    waitForConnection,
    runtime,
    accountId,
  );
}
