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

/** References only: session tools still own inspection, continuation, and live access checks. */
export async function buildXWorkSessionContext(params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  accountId: string;
  conversationId: string;
  requesterSessionKey: string;
}): Promise<string> {
  const { runtime, cfg, requesterSessionKey } = params;
  // Reuse the bounded origin store; do not maintain a second conversation/session index.
  const candidates = (await openXWorkOrigins(runtime).entries())
    .filter(
      ({ key, value }) =>
        value.accountId === params.accountId &&
        value.conversationId === params.conversationId &&
        value.senderTier === "maintainer" &&
        parseAgentSessionKey(key)?.rest.startsWith("dashboard:"),
    )
    .toSorted((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, 32);
  if (!candidates.length) {
    return "";
  }
  const readEntry = (sessionKey: string) =>
    runtime.agent.session.getSessionEntryAsync({
      sessionKey,
      agentId: parseAgentSessionKey(sessionKey)?.agentId,
      storePath: runtime.agent.session.resolveStorePath(cfg.session?.store, {
        agentId: parseAgentSessionKey(sessionKey)?.agentId,
      }),
    });
  const [source, { resolvePreparedSandboxRuntimeStatus }, visibility] = await Promise.all([
    readEntry(requesterSessionKey),
    import("openclaw/plugin-sdk/sandbox"),
    import("openclaw/plugin-sdk/session-visibility"),
  ]);
  const { sandboxed } = resolvePreparedSandboxRuntimeStatus({
    cfg,
    sessionKey: requesterSessionKey,
    preparedSessionEntry: source ?? null,
  });
  const checker = visibility.createSessionVisibilityRowChecker({
    action: "list",
    requesterSessionKey,
    visibility: visibility.resolveEffectiveSessionToolsVisibility({ cfg, sandboxed }),
    a2aPolicy: visibility.createAgentToAgentPolicy(cfg, { sandboxed }),
  });
  const references: string[] = [];
  for (const { key, value } of candidates) {
    const entry = await readEntry(key);
    if (
      !entry ||
      entry.archivedAt ||
      entry.incognito ||
      entry.visibility === "draft" ||
      entry.initializationPending ||
      entry.createdVia !== "spawn" ||
      entry.spawnedBy !== requesterSessionKey ||
      !checker.check({ key, spawnedBy: entry.spawnedBy }).allowed
    ) {
      continue;
    }
    // Titles and work transcripts may contain private content; expose only the origin and key.
    references.push(JSON.stringify({ sessionKey: key, originPostUrl: value.postUrl }));
    if (references.length === 8) {
      break;
    }
  }
  return references.length
    ? [
        "X work-session references (recent visible sessions started here; not exhaustive):",
        ...references,
        "Before starting another work session, determine whether this request continues one of these tasks. The same X thread can contain unrelated tasks; do not route by thread membership alone. For a continuation, inspect the matching session with available authorized session tools and use an available authorized continuation tool. These references do not deliver a message or grant access. If continuation is unavailable or denied, do not spawn a duplicate or claim the work resumed; follow the failure-reporting rules. Keep private work contents out of public replies. Work-session replies to X still require explicit approval.",
      ].join("\n")
    : "";
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
  return `X origin: @${origin.authorHandle} ${origin.postUrl}\nReplies are manual: draft ≤280 characters with the result and any PR link; show the user and ask. Post only after explicit approval in this session. Use tool message: {action:"send", channel:"x", target:${JSON.stringify(origin.postUrl)}, accountId:${JSON.stringify(origin.accountId)}, message:"<approved reply>"}. When useful, attach inspected proof images or video natively with media:"<approved file or URL>" rather than a sign-in-only link; show the attachment with the caption for approval. If unanswered, remind once at the end of your final summary.`;
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
