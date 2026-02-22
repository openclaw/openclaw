import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { listEnabledTuituiAccounts } from "./accounts.js";
import { sendMessageTuitui } from "./send.js";

const providerId = "tuitui";

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listEnabledTuituiAccounts(cfg).filter(
    (account) => account.enabled && account.credentialsSource !== "none",
  );
}

export const tuituiMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg);
    if (accounts.length === 0) return [];
    return Array.from(new Set<ChannelMessageActionName>(["send"]));
  },
  supportsButtons: () => false,
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) return null;
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", { required: true, allowEmpty: true });

      const result = await sendMessageTuitui(to ?? "", content ?? "", {
        accountId: accountId ?? undefined,
        cfg,
      });

      if (!result.ok) {
        return jsonResult({
          ok: false,
          error: result.error ?? "推推发送失败",
        });
      }
      return jsonResult({ ok: true, to, messageId: result.messageId });
    }
    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
