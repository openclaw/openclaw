import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
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

/** Retain the original reply boundary when a work session delegates again. */
export async function resolveXWorkOrigin(
  runtime: PluginRuntime,
  sessionKey: string,
  cfg?: OpenClawConfig,
): Promise<XWorkOrigin | undefined> {
  const store = openXWorkOrigins(runtime);
  const direct = await store.lookup(sessionKey);
  if (direct || !parseAgentSessionKey(sessionKey)?.rest.startsWith("dashboard:")) {
    return direct;
  }
  const configuredStore = (cfg ?? runtime.config.current()).session?.store;
  const visited = new Set<string>();
  let currentKey = sessionKey;
  while (!visited.has(currentKey)) {
    visited.add(currentKey);
    const entry = await runtime.agent.session.getSessionEntryAsync({
      sessionKey: currentKey,
      storePath: runtime.agent.session.resolveStorePath(configuredStore, {
        agentId: parseAgentSessionKey(currentKey)?.agentId,
      }),
    });
    if (entry?.createdVia !== "spawn" || !entry.spawnedBy) {
      return undefined;
    }
    currentKey = entry.spawnedBy;
    const origin = await store.lookup(currentKey);
    if (origin) {
      await store.registerIfAbsent(sessionKey, origin);
      return origin;
    }
  }
  return undefined;
}

function originGuidance(origin: XWorkOrigin): string {
  return `X origin: @${origin.authorHandle} ${origin.postUrl}\nReplies are manual: draft ≤280 characters with the result and any PR link; show the user and ask. Post only after explicit approval in this session. Use tool message: {action:"send", channel:"x", target:${JSON.stringify(origin.postUrl)}, accountId:${JSON.stringify(origin.accountId)}, message:"<approved reply>"}. If unanswered, remind once at the end of your final summary.`;
}

export function registerXWorkOriginGuidance(api: Pick<OpenClawPluginApi, "on" | "runtime">) {
  api.on("before_prompt_build", async (_event, ctx) => {
    if (!ctx.sessionKey) {
      return undefined;
    }
    const origin = await resolveXWorkOrigin(api.runtime, ctx.sessionKey);
    return origin ? { appendSystemContext: originGuidance(origin) } : undefined;
  });
}
