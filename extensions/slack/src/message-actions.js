import { createActionGate } from "../../../src/agents/tools/common.js";
import { listEnabledSlackAccounts } from "./accounts.js";
function listSlackMessageActions(cfg) {
  const accounts = listEnabledSlackAccounts(cfg).filter(
    (account) => account.botTokenSource !== "none"
  );
  if (accounts.length === 0) {
    return [];
  }
  const isActionEnabled = (key, defaultValue = true) => {
    for (const account of accounts) {
      const gate = createActionGate(
        account.actions ?? cfg.channels?.slack?.actions
      );
      if (gate(key, defaultValue)) {
        return true;
      }
    }
    return false;
  };
  const actions = /* @__PURE__ */ new Set(["send"]);
  if (isActionEnabled("reactions")) {
    actions.add("react");
    actions.add("reactions");
  }
  if (isActionEnabled("messages")) {
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
    actions.add("download-file");
  }
  if (isActionEnabled("pins")) {
    actions.add("pin");
    actions.add("unpin");
    actions.add("list-pins");
  }
  if (isActionEnabled("memberInfo")) {
    actions.add("member-info");
  }
  if (isActionEnabled("emojiList")) {
    actions.add("emoji-list");
  }
  return Array.from(actions);
}
function extractSlackToolSend(args) {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (action !== "sendMessage") {
    return null;
  }
  const to = typeof args.to === "string" ? args.to : void 0;
  if (!to) {
    return null;
  }
  const accountId = typeof args.accountId === "string" ? args.accountId.trim() : void 0;
  return { to, accountId };
}
export {
  extractSlackToolSend,
  listSlackMessageActions
};
