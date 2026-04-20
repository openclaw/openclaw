import type { ChannelHeartbeatDeps } from "openclaw/plugin-sdk/core";
import { resolveWhatsAppAccount } from "./accounts.js";
import { readWebAuthExistsForDecision, WHATSAPP_AUTH_UNSTABLE_CODE } from "./auth-store.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { loadWhatsAppChannelRuntime } from "./shared.js";

async function readHeartbeatAuthState(params: { authDir: string; deps?: ChannelHeartbeatDeps }) {
  if (params.deps?.readWebAuthExistsForDecision) {
    return await params.deps.readWebAuthExistsForDecision();
  }
  if (params.deps?.webAuthExists) {
    return {
      outcome: "stable" as const,
      exists: await params.deps.webAuthExists(),
    };
  }
  return await readWebAuthExistsForDecision(params.authDir);
}

export async function checkWhatsAppHeartbeatReady(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  deps?: ChannelHeartbeatDeps;
}) {
  if (params.cfg.web?.enabled === false) {
    return { ok: false as const, reason: "whatsapp-disabled" as const };
  }
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const authState = await readHeartbeatAuthState({
    authDir: account.authDir,
    deps: params.deps,
  });
  if (authState.outcome === "unstable") {
    return { ok: false as const, reason: WHATSAPP_AUTH_UNSTABLE_CODE };
  }
  if (!authState.exists) {
    return { ok: false as const, reason: "whatsapp-not-linked" as const };
  }
  const listenerActive = params.deps?.hasActiveWebListener
    ? params.deps.hasActiveWebListener(account.accountId)
    : Boolean((await loadWhatsAppChannelRuntime()).getActiveWebListener(account.accountId));
  if (!listenerActive) {
    return { ok: false as const, reason: "whatsapp-not-running" as const };
  }
  return { ok: true as const, reason: "ok" as const };
}
