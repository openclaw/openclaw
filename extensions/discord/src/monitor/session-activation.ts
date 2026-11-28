import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

/**
 * Applies a guild chat's stored `/activation mention|always` mode to mention gating,
 * as Telegram, WhatsApp, Google Chat and QQBot already do.
 *
 * Without this the owner-only command answers "Group activation set to always" and the
 * reply gate keeps following `requireMention` from config. A session with no stored mode,
 * or a failed read, keeps the configured rule.
 */
export async function resolveDiscordSessionRequireMention(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  configRequireMention: boolean;
}): Promise<boolean> {
  try {
    const entry = await getSessionEntryAsync({
      agentId: params.agentId,
      storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
      sessionKey: params.sessionKey,
      readConsistency: "latest",
    });
    const mode = entry?.groupActivation;
    if (mode === "always") {
      return false;
    }
    if (mode === "mention") {
      return true;
    }
  } catch (err) {
    logVerbose(`discord: session activation read failed, using config: ${String(err)}`);
  }
  return params.configRequireMention;
}
