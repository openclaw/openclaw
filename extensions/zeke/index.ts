import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { handleOpenClawProposalReply } from "./src/proposal-reply-hook.js";
import { createZekeTools } from "./src/tools.js";

export default definePluginEntry({
  id: "zeke",
  name: "Zeke Plugin",
  description: "Native OpenClaw tools backed by the ZekeFlow authority API",
  register(api) {
    for (const tool of createZekeTools(api)) {
      api.registerTool(tool as AnyAgentTool);
    }
    api.registerHook("before_dispatch", (event, ctx) =>
      handleOpenClawProposalReply(api, event, ctx),
    );
  },
});
