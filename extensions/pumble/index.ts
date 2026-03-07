import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { pumblePlugin } from "./src/channel.js";
import { normalizePumbleMessagingTarget } from "./src/normalize.js";
import {
  clearPumbleThreadContext,
  getPumbleThreadContext,
  setPumbleRuntime,
} from "./src/runtime.js";
import { registerPumbleSubagentHooks } from "./src/subagent-hooks.js";

function registerPumbleAutoThreadingHook(api: OpenClawPluginApi) {
  // Clean up thread context when sessions end to prevent memory leaks.
  api.on("session_end", (event) => {
    if (event.sessionKey) {
      clearPumbleThreadContext(event.sessionKey);
    }
  });

  api.on("before_tool_call", (event, ctx) => {
    if (event.toolName !== "message") {
      return;
    }
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) {
      return;
    }
    const threadCtx = getPumbleThreadContext(sessionKey);
    if (!threadCtx) {
      return;
    }
    const params = event.params;
    // If the agent passed threadId but not replyTo, treat threadId as replyTo.
    const replyTo = typeof params.replyTo === "string" ? params.replyTo.trim() : "";
    const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
    if (replyTo) {
      return;
    }
    if (threadId) {
      return { params: { ...params, replyTo: threadId } };
    }
    // If channel is explicitly set to something other than pumble, skip.
    const channel = typeof params.channel === "string" ? params.channel.trim().toLowerCase() : "";
    if (channel && channel !== "pumble") {
      return;
    }
    // Only auto-inject when the target matches the originating channel
    // (or when no target is specified, implying the current channel).
    const to = typeof params.to === "string" ? params.to.trim() : "";
    const target = typeof params.target === "string" ? params.target.trim() : "";
    const effectiveTo = to || target;
    if (effectiveTo) {
      // Normalize both sides so "#ID" and "channel:ID" compare equal.
      const normalized = normalizePumbleMessagingTarget(effectiveTo)?.toLowerCase();
      if (normalized && normalized !== threadCtx.to) {
        return;
      }
    }
    return { params: { ...params, replyTo: threadCtx.threadRootId } };
  });
}

const plugin = {
  id: "pumble",
  name: "Pumble",
  description: "Pumble channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setPumbleRuntime(api.runtime);
    api.registerChannel({ plugin: pumblePlugin });
    registerPumbleSubagentHooks(api);
    registerPumbleAutoThreadingHook(api);
  },
};

export default plugin;
