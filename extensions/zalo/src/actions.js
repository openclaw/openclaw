import { extractToolSend, jsonResult, readStringParam } from "openclaw/plugin-sdk/zalo";
import { listEnabledZaloAccounts } from "./accounts.js";
import { sendMessageZalo } from "./send.js";
const providerId = "zalo";
function listEnabledAccounts(cfg) {
  return listEnabledZaloAccounts(cfg).filter(
    (account) => account.enabled && account.tokenSource !== "none"
  );
}
const zaloMessageActions = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const actions = /* @__PURE__ */ new Set(["send"]);
    return Array.from(actions);
  },
  supportsButtons: () => false,
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const result = await sendMessageZalo(to ?? "", content ?? "", {
        accountId: accountId ?? void 0,
        mediaUrl: mediaUrl ?? void 0,
        cfg
      });
      if (!result.ok) {
        return jsonResult({
          ok: false,
          error: result.error ?? "Failed to send Zalo message"
        });
      }
      return jsonResult({ ok: true, to, messageId: result.messageId });
    }
    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  }
};
export {
  zaloMessageActions
};
