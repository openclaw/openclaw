// Lobster plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "./runtime-api.js";
import {
  LOBSTER_CONTINUATION_TTL_MS,
  type LobsterContinuationOwner,
} from "./src/lobster-continuations.js";
import { createLobsterTool } from "./src/lobster-tool.js";

export default definePluginEntry({
  id: "lobster",
  name: "Lobster",
  description: "Optional local shell helper tools",
  register(api: OpenClawPluginApi) {
    let continuationStore: PluginStateSyncKeyedStore<unknown> | undefined;
    const openContinuationStore = () =>
      (continuationStore ??= api.runtime.state.openSyncKeyedStore<unknown>({
        namespace: "continuations",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
        defaultTtlMs: LOBSTER_CONTINUATION_TTL_MS,
      }));
    api.registerTool(
      ((ctx: OpenClawPluginToolContext) => {
        if (ctx.sandboxed) {
          return null;
        }
        const taskFlow =
          api.runtime?.tasks.managedFlows && ctx.sessionKey
            ? api.runtime.tasks.managedFlows.fromToolContext(ctx)
            : undefined;
        const continuationOwner: LobsterContinuationOwner | undefined =
          ctx.sessionKey && ctx.sessionId
            ? {
                sessionKey: ctx.sessionKey,
                sessionId: ctx.sessionId,
                openStore: openContinuationStore,
                resolveCurrentSessionId: () =>
                  api.runtime.agent.session.getSessionEntry({
                    agentId: ctx.agentId,
                    sessionKey: ctx.sessionKey!,
                    readConsistency: "latest",
                  })?.sessionId,
              }
            : undefined;
        return createLobsterTool(api, { taskFlow, continuationOwner }) as AnyAgentTool;
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );
  },
});
