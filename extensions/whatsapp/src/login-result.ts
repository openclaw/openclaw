import type { WABrowserDescription } from "baileys";
import { info, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { closeWaSocket } from "./connection-controller.js";
import {
  createWaSocket,
  formatError,
  getStatusCode,
  prepareWebAuthForLogin,
  readWebAuthExistsForDecision,
  waitForWaConnection,
  WhatsAppAuthUnstableError,
} from "./session.js";
import type { WhatsAppSocketTimingOptions } from "./socket-timing.js";

const LOGGED_OUT_STATUS = 401;
const POST_PAIRING_RESTART_STATUS = 515;
const TIMED_OUT_STATUS = 408;
const WHATSAPP_LOGIN_RESTART_MESSAGE =
  "WhatsApp asked for a restart after pairing (code 515); waiting for creds to save…";
const WHATSAPP_LOGIN_TIMEOUT_RESTART_MESSAGE =
  "WhatsApp connection timed out before login; retrying with a fresh socket…";
const WHATSAPP_LOGGED_OUT_RELINK_MESSAGE =
  "WhatsApp reported the session is logged out. Cleared cached web session; please rerun openclaw channels login and scan the QR again.";
const WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE =
  "WhatsApp connected, but saving the linked credentials has not settled on disk yet. Retry login in a moment.";
const WHATSAPP_LOGIN_AUTH_NOT_PERSISTED_MESSAGE =
  "WhatsApp connected, but the linked credentials were not found on disk. Retry login in a moment.";
const WHATSAPP_LOGIN_AUTH_NOT_CLEARED_MESSAGE =
  "existing auth could not be cleared. Remove or fix the configured WhatsApp auth directory, then retry login.";

type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;
type LoginSocketRestartKind = "post-pairing" | "timeout";
type LoginSocketPrepareReason = "initial" | "post-pairing" | "timeout" | "logged-out";

function getLoginSocketRestartKind(statusCode: number | undefined): LoginSocketRestartKind | null {
  if (statusCode === POST_PAIRING_RESTART_STATUS) {
    return "post-pairing";
  }
  if (statusCode === TIMED_OUT_STATUS) {
    return "timeout";
  }
  return null;
}

function getLoginSocketRestartMessage(kind: LoginSocketRestartKind): string {
  return kind === "timeout"
    ? WHATSAPP_LOGIN_TIMEOUT_RESTART_MESSAGE
    : WHATSAPP_LOGIN_RESTART_MESSAGE;
}

type WhatsAppLoginWaitResult =
  | {
      outcome: "connected";
      restarted: boolean;
      sock: WaSocket;
    }
  | {
      outcome: "logged-out";
      message: string;
      statusCode: number;
      error: unknown;
    }
  | {
      outcome: "failed";
      message: string;
      statusCode?: number;
      error: unknown;
    };

type CredentialPersistenceFailure = { error: unknown };

async function waitForLoginSocket(params: {
  wait: () => Promise<void>;
  credentialPersistenceFailure?: Promise<CredentialPersistenceFailure>;
}): Promise<void> {
  if (!params.credentialPersistenceFailure) {
    await params.wait();
    return;
  }
  const outcome = await Promise.race([
    params.wait().then(() => ({ kind: "connected" }) as const),
    params.credentialPersistenceFailure.then((failure) => ({
      kind: "credential-persistence-failed" as const,
      failure,
    })),
  ]);
  if (outcome.kind === "credential-persistence-failed") {
    throw outcome.failure.error;
  }
}

function throwIfCredentialPersistenceFailed(
  getFailure?: () => CredentialPersistenceFailure | null,
): void {
  const failure = getFailure?.();
  if (failure) {
    throw failure.error;
  }
}

export async function waitForWhatsAppLoginResult(params: {
  sock: WaSocket;
  authDir: string;
  isLegacyAuthDir: boolean;
  verbose: boolean;
  runtime: RuntimeEnv;
  waitForConnection?: typeof waitForWaConnection;
  createSocket?: typeof createWaSocket;
  socketTiming?: WhatsAppSocketTimingOptions;
  qrTimeoutMs?: number;
  browser?: WABrowserDescription;
  onQr?: (qr: string) => void;
  beforeCreateLoginSocket?: (context: { reason: LoginSocketPrepareReason }) => Promise<void> | void;
  prepareLoginSocket?: (
    sock: WaSocket,
    context: { reason: LoginSocketPrepareReason },
  ) => Promise<void>;
  onSocketReplaced?: (sock: WaSocket) => void;
  beforeCredentialPersistence?: () => Promise<void>;
  onCredentialPersistenceError?: (error: unknown) => void;
  onCredentialPersistenceTask?: (task: Promise<unknown>) => void;
  waitForCredentialPersistence?: () => Promise<void>;
  credentialPersistenceFailure?: Promise<CredentialPersistenceFailure>;
  getCredentialPersistenceFailure?: () => CredentialPersistenceFailure | null;
}): Promise<WhatsAppLoginWaitResult> {
  const wait = params.waitForConnection ?? waitForWaConnection;
  const createSocket = params.createSocket ?? createWaSocket;
  let currentSock = params.sock;
  let postPairingRestarted = false;
  let timeoutRestarted = false;
  let loggedOutRestarted = false;
  let prepareReason: LoginSocketPrepareReason = "initial";

  const replaceLoginSocket = async (
    opts: { closeCurrent?: boolean } = {},
  ): Promise<WhatsAppLoginWaitResult | null> => {
    if (opts.closeCurrent ?? true) {
      closeWaSocket(currentSock);
    }
    try {
      await params.beforeCreateLoginSocket?.({ reason: prepareReason });
      currentSock = await createSocket(false, params.verbose, {
        authDir: params.authDir,
        ...params.socketTiming,
        ...(params.qrTimeoutMs === undefined ? {} : { qrTimeoutMs: params.qrTimeoutMs }),
        ...(params.browser ? { browser: params.browser } : {}),
        onQr: params.onQr,
        beforeCredentialPersistence: params.beforeCredentialPersistence,
        onCredentialPersistenceError: params.onCredentialPersistenceError,
        onCredentialPersistenceTask: params.onCredentialPersistenceTask,
      });
      params.onSocketReplaced?.(currentSock);
      return null;
    } catch (createErr) {
      return {
        outcome: "failed",
        message: formatError(createErr),
        statusCode: getStatusCode(createErr),
        error: createErr,
      };
    }
  };

  while (true) {
    try {
      await waitForLoginSocket({
        wait: async () => {
          await params.prepareLoginSocket?.(currentSock, { reason: prepareReason });
          await wait(currentSock, { timeout: "none" });
        },
        credentialPersistenceFailure: params.credentialPersistenceFailure,
      });
      await params.waitForCredentialPersistence?.();
      throwIfCredentialPersistenceFailed(params.getCredentialPersistenceFailure);
      // Socket open only proves in-memory auth; require persisted creds before success.
      const persistedAuth = await readWebAuthExistsForDecision(params.authDir);
      throwIfCredentialPersistenceFailed(params.getCredentialPersistenceFailure);
      if (persistedAuth.outcome === "unstable") {
        return {
          outcome: "failed",
          message: WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE,
          error: new WhatsAppAuthUnstableError(WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE),
        };
      }
      if (!persistedAuth.exists) {
        return {
          outcome: "failed",
          message: WHATSAPP_LOGIN_AUTH_NOT_PERSISTED_MESSAGE,
          error: new WhatsAppAuthUnstableError(WHATSAPP_LOGIN_AUTH_NOT_PERSISTED_MESSAGE),
        };
      }
      return {
        outcome: "connected",
        restarted: postPairingRestarted || timeoutRestarted || loggedOutRestarted,
        sock: currentSock,
      };
    } catch (err) {
      const statusCode = getStatusCode(err);
      const restartKind = getLoginSocketRestartKind(statusCode);
      const canRestart =
        (restartKind === "post-pairing" && !postPairingRestarted) ||
        (restartKind === "timeout" && !timeoutRestarted);
      if (restartKind && canRestart) {
        if (restartKind === "post-pairing") {
          postPairingRestarted = true;
        } else {
          timeoutRestarted = true;
        }
        prepareReason = restartKind;
        params.runtime.log(info(getLoginSocketRestartMessage(restartKind)));
        const replacementFailure = await replaceLoginSocket();
        if (replacementFailure) {
          return replacementFailure;
        }
        continue;
      }

      if (statusCode === LOGGED_OUT_STATUS) {
        if (loggedOutRestarted) {
          return {
            outcome: "logged-out",
            message: WHATSAPP_LOGGED_OUT_RELINK_MESSAGE,
            statusCode: LOGGED_OUT_STATUS,
            error: err,
          };
        }
        closeWaSocket(currentSock);
        const preparation = await prepareWebAuthForLogin({
          authDir: params.authDir,
          isLegacyAuthDir: params.isLegacyAuthDir,
          mode: "clear-existing",
          runtime: params.runtime,
          beforeCredentialPersistence: params.beforeCredentialPersistence,
        });
        if (preparation === "unstable") {
          return {
            outcome: "failed",
            message: WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE,
            error: new WhatsAppAuthUnstableError(WHATSAPP_LOGIN_AUTH_UNSTABLE_MESSAGE),
          };
        }
        if (preparation === "not-cleared") {
          return {
            outcome: "failed",
            message: WHATSAPP_LOGIN_AUTH_NOT_CLEARED_MESSAGE,
            error: err,
          };
        }
        loggedOutRestarted = true;
        prepareReason = "logged-out";
        const replacementFailure = await replaceLoginSocket({ closeCurrent: false });
        if (replacementFailure) {
          return replacementFailure;
        }
        continue;
      }

      return {
        outcome: "failed",
        message: formatError(err),
        statusCode,
        error: err,
      };
    }
  }
}
