import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { XSenderTier } from "./guest-policy.js";

type XWorkOrigin = {
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
  return `X origin: @${origin.authorHandle} ${origin.postUrl}\nReplies are manual: draft ≤280 characters with the result and any PR link; show the user and ask. Post only after explicit approval in this session. Use tool message: {action:"send", channel:"x", target:${JSON.stringify(origin.postUrl)}, accountId:${JSON.stringify(origin.accountId)}, message:"<approved reply>"}. If unanswered, remind once at the end of your final summary.`;
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
