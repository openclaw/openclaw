import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { logInfo } from "openclaw/plugin-sdk/logging-core";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, success, defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "./accounts.js";
import {
  prepareWebAuthForLogin,
  restoreCredsFromBackupIfNeeded,
  WhatsAppAuthUnstableError,
} from "./auth-store.js";
import { closeWaSocketSoon } from "./connection-controller.js";
import { formatWhatsAppAccountCommand, prepareWebAuthForLoginOrThrow } from "./login-auth.js";
import { waitForWhatsAppLoginResult } from "./login-result.js";
import {
  assertLinkedLoginSocketMatchesPairingPhoneNumber,
  createWhatsAppPairingCodeReadySignal,
  formatPairingCode,
  isLinkedLoginSocket,
  normalizeWhatsAppPairingPhoneNumber,
} from "./phone-code.js";
import { renderQrTerminal } from "./qr-terminal.js";
import { createWaSocket, WHATSAPP_PHONE_CODE_BROWSER, waitForWaConnection } from "./session.js";
import { resolveWhatsAppSocketTiming } from "./socket-timing.js";

const QR_LINK_INSTRUCTION = "Open the WhatsApp app, go to Linked Devices, then scan this QR:";
const CLEAR_TERMINAL = "\x1b[2J\x1b[H";
const PHONE_CODE_PAIRING_READY_TIMEOUT_MS = 5 * 60_000;

type CredentialPersistenceFailure = { error: unknown };

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
  const socketTiming = resolveWhatsAppSocketTiming();
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
  const credentialPersistenceFailure = createDeferred<CredentialPersistenceFailure>();
  const onCredentialPersistenceError = (error: unknown) => {
    if (credentialPersistenceState.failure) {
      return;
    }
    credentialPersistenceState.failure = { error };
    credentialPersistenceFailure.resolve(credentialPersistenceState.failure);
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
          formatWhatsAppAccountCommand("logout", account.accountId),
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
    ...(phoneMode ? { qrTimeoutMs: PHONE_CODE_PAIRING_READY_TIMEOUT_MS } : {}),
    ...(phoneMode ? { browser: WHATSAPP_PHONE_CODE_BROWSER } : {}),
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
      ...(phoneMode ? { qrTimeoutMs: PHONE_CODE_PAIRING_READY_TIMEOUT_MS } : {}),
      ...(phoneMode ? { browser: WHATSAPP_PHONE_CODE_BROWSER } : {}),
      onQr,
      ...phoneLoginHooks,
      ...credentialPersistenceOptions,
      credentialPersistenceFailure: credentialPersistenceFailure.promise,
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
