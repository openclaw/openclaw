import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildCodexProvider } from "./provider.js";
import { createCodexCommand } from "./src/commands.js";
import {
  CodexContinuityBridge,
  setCodexContinuityBridgeForRuntime,
} from "./src/continuity/bridge.js";
import { registerCodexContinuityHttpRoutes } from "./src/continuity/http.js";
import type { CodexBridgeAuditEvent, CodexBridgeWatchRecord } from "./src/continuity/types.js";
import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
} from "./src/conversation-binding.js";
import { buildCodexMigrationProvider } from "./src/migration/provider.js";

export default definePluginEntry({
  id: "codex",
  name: "Codex",
  description: "Codex app-server harness and Codex-managed GPT model catalog.",
  register(api) {
    const resolveCurrentPluginConfig = () =>
      resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "codex",
        api.pluginConfig as Record<string, unknown>,
      ) ?? api.pluginConfig;
    api.registerAgentHarness(createCodexAppServerAgentHarness({ pluginConfig: api.pluginConfig }));
    api.registerProvider(buildCodexProvider({ pluginConfig: api.pluginConfig }));
    api.registerMediaUnderstandingProvider(
      buildCodexMediaUnderstandingProvider({ pluginConfig: api.pluginConfig }),
    );
    api.registerMigrationProvider(buildCodexMigrationProvider());
    const continuityBridge = new CodexContinuityBridge({
      resolvePluginConfig: resolveCurrentPluginConfig,
      configForAppServer: () => api.config,
      watchStore: api.runtime.state.openKeyedStore<CodexBridgeWatchRecord>({
        namespace: "codex.continuity.watch",
        maxEntries: 500,
      }),
      eventStore: api.runtime.state.openKeyedStore<CodexBridgeAuditEvent>({
        namespace: "codex.continuity.events",
        maxEntries: 1_000,
      }),
      logger: api.logger,
      sendTelegram: async ({ channel, target, text, accountId, threadId }) => {
        if (channel !== "telegram") {
          throw new Error(`unsupported notify channel: ${channel}`);
        }
        const adapter = await api.runtime.channel.outbound.loadAdapter("telegram");
        const send = adapter?.sendText;
        if (!send) {
          throw new Error("telegram runtime unavailable");
        }
        await send({
          cfg: api.config,
          to: target,
          text,
          ...(threadId != null ? { threadId } : {}),
          ...(accountId ? { accountId } : {}),
        });
      },
    });
    setCodexContinuityBridgeForRuntime(continuityBridge);
    api.registerService({
      id: "codex-continuity",
      start: () => continuityBridge.start(),
      stop: () => continuityBridge.stop(),
    });
    api.registerRuntimeLifecycle({
      id: "codex-continuity",
      cleanup: () => {
        continuityBridge.stop();
        setCodexContinuityBridgeForRuntime(undefined);
      },
    });
    registerCodexContinuityHttpRoutes({
      registerHttpRoute: api.registerHttpRoute,
      bridge: continuityBridge,
    });
    api.registerCommand(createCodexCommand({ pluginConfig: api.pluginConfig }));
    api.on("inbound_claim", (event, ctx) =>
      handleCodexConversationInboundClaim(event, ctx, {
        pluginConfig: resolveCurrentPluginConfig(),
      }),
    );
    api.onConversationBindingResolved?.(handleCodexConversationBindingResolved);
  },
});
