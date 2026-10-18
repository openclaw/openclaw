import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { XSenderTier } from "./guest-policy.js";

export type XWorkOrigin = {
  accountId: string;
  postId: string;
  postUrl: string;
  authorHandle: string;
  conversationId: string;
  senderTier: XSenderTier;
};

const stores = new WeakMap<PluginRuntime, ReturnType<typeof createStore>>();

function createStore(runtime: PluginRuntime) {
  return runtime.state.openKeyedStore<XWorkOrigin>({
    namespace: "x.work-origin",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
  });
}

export function openXWorkOrigins(runtime: PluginRuntime) {
  let store = stores.get(runtime);
  if (!store) {
    store = createStore(runtime);
    stores.set(runtime, store);
  }
  return store;
}

function originGuidance(origin: XWorkOrigin): string {
  return `This session was started from an X post by @${origin.authorHandle}: ${origin.postUrl}. Replies to X are manual. Never post to X on your own. When you have a result worth sharing (finding, fix, PR, or a clear "can't reproduce"), draft a reply of at most 280 characters with the key result and any PR link, show it to the user, and ask whether to post it. Post only after the user explicitly says so in this session, using the message tool with channel "x" and that post URL as the target. If the user has not answered, remind them once at the end of your final summary.\nUse accountId ${JSON.stringify(origin.accountId)} for that message-tool reply.`;
}

export function registerXWorkOriginGuidance(api: Pick<OpenClawPluginApi, "on" | "runtime">) {
  api.on("before_prompt_build", async (_event, ctx) => {
    if (!ctx.sessionKey) {
      return undefined;
    }
    const origin = await openXWorkOrigins(api.runtime).lookup(ctx.sessionKey);
    return origin ? { appendSystemContext: originGuidance(origin) } : undefined;
  });
}
