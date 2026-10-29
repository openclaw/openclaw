import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { DiscordPluralKitConfig, PluralKitMessageInfo } from "../pluralkit.js";
import { loadPluralKitRuntime } from "./message-handler.preflight-runtime.js";
import type { DiscordMessageEvent } from "./message-handler.preflight.types.js";

export async function resolveDiscordPreflightPluralKitInfo(params: {
  message: DiscordMessageEvent["message"];
  webhookId: string | null;
  config?: DiscordPluralKitConfig;
  abortSignal?: AbortSignal;
}): Promise<PluralKitMessageInfo | null> {
  if (!params.config?.enabled || !params.webhookId) {
    return null;
  }
  try {
    const { fetchPluralKitMessageInfo } = await loadPluralKitRuntime();
    const info = await fetchPluralKitMessageInfo({
      messageId: params.message.id,
      config: params.config,
      signal: params.abortSignal,
    });
    return params.abortSignal?.aborted ? null : info;
  } catch (err) {
    logVerbose(`discord: pluralkit lookup failed for ${params.message.id}: ${String(err)}`);
    return null;
  }
}
