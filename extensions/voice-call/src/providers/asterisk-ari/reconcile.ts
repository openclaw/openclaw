import type { CallManager } from "../../manager.js";
import type { AriClient } from "./ari-client.js";
import type { AriConfig } from "./types.js";
import { makeEvent } from "./utils.js";

export async function reconcileLingeringCalls(params: {
  client: AriClient;
  cfg: AriConfig;
  manager: CallManager;
  providerName: string;
}): Promise<void> {
  try {
    const channels = await params.client.listChannels();
    const appChannels = channels.filter((ch) => {
      if (ch.dialplan?.app_name !== "Stasis") return false;

      // ARI: dialplan.app_name is the dialplan application (usually "Stasis").
      // dialplan.app_data is the Stasis payload: "<app>,<args...>".
      // Match by the *actual* Stasis app name (first token), not substring search.
      const appData = (ch.dialplan?.app_data ?? "").trim();
      const stasisApp = appData.split(",")[0]?.trim();
      return stasisApp === params.cfg.app;
    });
    for (const channel of appChannels) {
      await params.client.safeHangupChannel(channel.id).catch(() => {});
    }

    const calls = params.manager
      .getActiveCalls()
      .filter((call) => call.provider === params.providerName);
    for (const call of calls) {
      const result = await params.manager.endCall(call.callId);
      if (!result.success) {
        params.manager.processEvent(
          makeEvent({
            type: "call.ended",
            callId: call.callId,
            providerCallId: call.providerCallId,
            reason: "hangup-bot",
          }),
        );
      }
    }
  } catch (err) {
    console.warn("[ari] Failed to reconcile lingering calls", err);
  }
}
