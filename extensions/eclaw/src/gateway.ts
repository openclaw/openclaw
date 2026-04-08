/**
 * Gateway lifecycle for the E-Claw channel plugin.
 *
 * Responsibilities on startAccount:
 *   1. Resolve credentials (config + env).
 *   2. Construct an EclawClient and register it in the client registry.
 *   3. Generate a per-session callback token.
 *   4. POST /api/channel/register so the E-Claw backend will push webhooks
 *      to the OpenClaw gateway.
 *   5. Auto-bind an entity slot via POST /api/channel/bind.
 *   6. Keep the promise alive until the gateway aborts the account.
 *
 * The inbound webhook itself is served by the webhook-handler module via
 * the OpenClaw plugin HTTP route registry (mirrors the npm package's
 * `/eclaw-webhook` route + Bearer-token routing).
 */

import { randomBytes } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { resolveAccount } from "./accounts.js";
import { EclawClient } from "./client.js";
import {
  clearEclawClient,
  setEclawClient,
} from "./client-registry.js";
import {
  registerEclawWebhookToken,
  unregisterEclawWebhookToken,
} from "./webhook-registry.js";

export type EclawGatewayContext = {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};

function formatCallbackUrl(publicUrl: string | undefined): string {
  const base = (publicUrl ?? "").replace(/\/+$/, "") || "http://localhost";
  return `${base}/eclaw-webhook`;
}

export async function startEclawAccount(ctx: EclawGatewayContext): Promise<unknown> {
  const { cfg, accountId, abortSignal, log } = ctx;
  const account = resolveAccount(cfg, accountId);

  if (!account.enabled) {
    log?.info?.(`E-Claw account ${accountId} disabled, skipping`);
    return waitUntilAbort(abortSignal);
  }
  if (!account.apiKey) {
    log?.warn?.(
      `E-Claw account ${accountId} missing apiKey — set channels.eclaw.apiKey or ECLAW_API_KEY`,
    );
    return waitUntilAbort(abortSignal);
  }

  const client = new EclawClient(account);
  setEclawClient(accountId, client);

  const callbackToken = randomBytes(32).toString("hex");
  const callbackUrl = formatCallbackUrl(account.webhookUrl);

  registerEclawWebhookToken(callbackToken, accountId);
  log?.info?.(`E-Claw webhook registered at: ${callbackUrl} (account: ${accountId})`);

  try {
    const reg = await client.registerCallback(callbackUrl, callbackToken);
    log?.info?.(
      `E-Claw registered: deviceId=${reg.deviceId} entities=${reg.entities.length}`,
    );

    const bind = await client.bindEntity(undefined, account.botName);
    log?.info?.(
      `E-Claw bound slot ${bind.entityId} (publicCode=${bind.publicCode}) for account ${accountId}`,
    );
  } catch (err) {
    log?.error?.(
      `E-Claw setup failed for account ${accountId}: ${(err as Error).message}`,
    );
    unregisterEclawWebhookToken(callbackToken);
    clearEclawClient(accountId);
    return waitUntilAbort(abortSignal);
  }

  return waitUntilAbort(abortSignal, () => {
    log?.info?.(`Stopping E-Claw account ${accountId}`);
    void client.unregisterCallback();
    unregisterEclawWebhookToken(callbackToken);
    clearEclawClient(accountId);
  });
}

export async function stopEclawAccount(ctx: EclawGatewayContext): Promise<void> {
  ctx.log?.info?.(`E-Claw account ${ctx.accountId} stopped`);
}
