import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logInfo } from "openclaw/plugin-sdk/text-runtime";
import type { createWaSocket, waitForWaConnection } from "./session.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { waitForWhatsAppLoginResult } from "./connection-controller.js";

type LoginSocketFactory = typeof createWaSocket;
type LoginWaiter = typeof waitForWaConnection;

type LoginWebResolvedArgs = {
  runtime: RuntimeEnv;
  accountId: string | undefined;
  waitForConnection: LoginWaiter | undefined;
  createSocket: LoginSocketFactory | undefined;
};

function isRuntimeEnvLike(value: unknown): value is RuntimeEnv {
  return !!value && typeof value === "object" && "log" in value;
}

function resolveLoginWebArgs(
  arg2?: RuntimeEnv | LoginWaiter,
  arg3?: RuntimeEnv | string,
  arg4?: string | LoginSocketFactory,
  arg5?: LoginSocketFactory,
): LoginWebResolvedArgs {
  if (typeof arg2 === "function") {
    return {
      runtime: isRuntimeEnvLike(arg3) ? arg3 : defaultRuntime,
      accountId: typeof arg4 === "string" ? arg4 : undefined,
      waitForConnection: arg2,
      createSocket: arg5,
    };
  }

  return {
    runtime: arg2 ?? defaultRuntime,
    accountId: typeof arg3 === "string" ? arg3 : typeof arg4 === "string" ? arg4 : undefined,
    waitForConnection: undefined,
    createSocket:
      typeof arg4 === "function"
        ? arg4
        : arg5,
  };
}

export async function loginWeb(
  verbose: boolean,
  arg2?: RuntimeEnv | LoginWaiter,
  arg3?: RuntimeEnv | string,
  arg4?: string | LoginSocketFactory,
  arg5?: LoginSocketFactory,
) {
  const { runtime, accountId, waitForConnection, createSocket } = resolveLoginWebArgs(
    arg2,
    arg3,
    arg4,
    arg5,
  );
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  logInfo("Waiting for WhatsApp connection...", runtime);
  const result = await waitForWhatsAppLoginResult({
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    verbose,
    runtime,
    waitForConnection,
    createSocket: createSocket ?? (async (printQr, socketVerbose, opts) => {
      const { createWaSocket } = await import("./session.js");
      return createWaSocket(printQr, socketVerbose, opts);
    }),
  });
  try {
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
    result.closeSocket();
  }
}
