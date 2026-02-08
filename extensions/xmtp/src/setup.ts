/**
 * XMTP setup: generate identity, show public address, persist.
 * No QR, no invite URL, no join logic.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { resolveXmtpAccount, updateXmtpSection, type CoreConfig } from "./accounts.js";
import { writeXmtpVarsToEnv } from "./lib/env-file.js";
import {
  generateEncryptionKeyHex,
  generatePrivateKey,
  walletAddressFromPrivateKey,
} from "./lib/identity.js";
import { runTemporaryXmtpClient } from "./lib/xmtp-client.js";
import { getXmtpRuntime } from "./runtime.js";

let setupResult: {
  walletKey: string;
  dbEncryptionKey: string;
  env: "production" | "dev";
  publicAddress: string;
} | null = null;

export async function handleSetup(params: {
  accountId?: string;
  env?: "production" | "dev";
}): Promise<{ publicAddress: string }> {
  const env = params.env === "dev" ? "dev" : "production";

  const walletKey = generatePrivateKey();
  const dbEncryptionKey = generateEncryptionKeyHex();
  const publicAddress = walletAddressFromPrivateKey(walletKey);

  await runTemporaryXmtpClient({
    walletKey,
    dbEncryptionKey,
    env,
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
  });

  setupResult = { walletKey, dbEncryptionKey, env, publicAddress };
  return { publicAddress };
}

export function handleSetupStatus(): {
  configured: boolean;
  publicAddress?: string;
  setupPending?: boolean;
} {
  if (setupResult) {
    return {
      configured: false,
      setupPending: true,
      publicAddress: setupResult.publicAddress,
    };
  }

  const runtime = getXmtpRuntime();
  const cfg = runtime.config.loadConfig() as OpenClawConfig;
  const account = resolveXmtpAccount({ cfg: cfg as CoreConfig });

  return {
    configured: account.configured,
    publicAddress: account.configured ? account.publicAddress : undefined,
  };
}

export async function handleSetupComplete(): Promise<{ saved: true }> {
  if (!setupResult) {
    throw new Error("No active setup to complete. Run xmtp.setup first.");
  }

  const runtime = getXmtpRuntime();
  const cfg = runtime.config.loadConfig() as OpenClawConfig;

  const next = updateXmtpSection(cfg, {
    walletKey: setupResult.walletKey,
    dbEncryptionKey: setupResult.dbEncryptionKey,
    env: setupResult.env,
    publicAddress: setupResult.publicAddress,
    enabled: true,
  });

  writeXmtpVarsToEnv({
    walletKey: setupResult.walletKey,
    dbEncryptionKey: setupResult.dbEncryptionKey,
    env: setupResult.env,
  });

  await runtime.config.writeConfigFile(next);
  setupResult = null;

  return { saved: true };
}

export function handleSetupCancel(): { cancelled: boolean } {
  const wasPending = setupResult !== null;
  setupResult = null;
  return { cancelled: wasPending };
}
