/**
 * Bundled Codex plugin entry: app-server harness, model provider, media
 * understanding, migration provider, CLI-session commands, and binding hooks.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import {
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildCodexProvider } from "./provider.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createLazyCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding-store.js";
import type { CodexPluginsConfigBlock } from "./src/command-plugins-management.js";
import { createCodexCommand } from "./src/commands.js";
import { buildCodexMigrationProvider } from "./src/migration/provider.js";
import {
  createCodexCliSessionNodeHostCommands,
  createCodexCliSessionNodeInvokePolicies,
} from "./src/node-cli-session-registration.js";
import { createCodexWebSearchProvider } from "./src/web-search-provider.js";

const ENDED_SESSION_REASONS: ReadonlySet<string> = new Set([
  "new",
  "reset",
  "idle",
  "daily",
  "deleted",
]);

export default definePluginEntry({
  id: "codex",
  name: "Codex",
  description: "Codex app-server harness and Codex-managed GPT model catalog.",
  register(api) {
    const runtimeConfigLoader = api.runtime.config?.current
      ? () => api.runtime.config?.current() as OpenClawConfig
      : undefined;
    const resolveCurrentConfig = () => runtimeConfigLoader?.();
    const loadNodeCliSessions = () => import("./src/node-cli-sessions.js");
    const resolveCurrentPluginConfig = () =>
      // Codex plugin config can change at runtime; resolve from live config for
      // harness attempts and binding claims instead of keeping startup values.
      resolveLivePluginConfigObject(
        runtimeConfigLoader,
        "codex",
        api.pluginConfig as Record<string, unknown>,
      );
    const bindingStore = createLazyCodexAppServerBindingStore(
      api.runtime.state.openSyncKeyedStore<StoredCodexAppServerBinding>({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      }),
    );
    api.registerAgentHarness(
      createCodexAppServerAgentHarness({
        bindingStore,
        resolveConfig: resolveCurrentConfig,
        resolvePluginConfig: resolveCurrentPluginConfig,
      }),
    );
    api.registerProvider(buildCodexProvider({ pluginConfig: api.pluginConfig }));
    api.registerMediaUnderstandingProvider(
      buildCodexMediaUnderstandingProvider({ resolvePluginConfig: resolveCurrentPluginConfig }),
    );
    api.registerWebSearchProvider(
      createCodexWebSearchProvider({ resolvePluginConfig: resolveCurrentPluginConfig }),
    );
    api.registerMigrationProvider(buildCodexMigrationProvider({ runtime: api.runtime }));
    for (const command of createCodexCliSessionNodeHostCommands()) {
      api.registerNodeHostCommand(command);
    }
    for (const policy of createCodexCliSessionNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
    api.registerCommand(
      createCodexCommand({
        resolvePluginConfig: resolveCurrentPluginConfig,
        deps: {
          bindingStore,
          listCodexCliSessionsOnNode: async (params) =>
            await (
              await loadNodeCliSessions()
            ).listCodexCliSessionsOnNode({
              runtime: api.runtime,
              ...params,
            }),
          resolveCodexCliSessionForBindingOnNode: async (params) =>
            await (
              await loadNodeCliSessions()
            ).resolveCodexCliSessionForBindingOnNode({
              runtime: api.runtime,
              ...params,
            }),
          codexPluginsManagementIo: {
            readConfig: () => {
              const current = (api.runtime.config?.current?.() ?? {}) as OpenClawConfig;
              const codexPlugins = resolvePluginConfigObject(current, "codex")?.codexPlugins;
              if (
                !codexPlugins ||
                typeof codexPlugins !== "object" ||
                Array.isArray(codexPlugins)
              ) {
                return Promise.resolve({});
              }
              const block = codexPlugins as Record<string, unknown>;
              const declared = block.plugins;
              if (!declared || typeof declared !== "object") {
                return Promise.resolve({
                  enabled: block.enabled === true,
                });
              }
              return Promise.resolve({
                enabled: block.enabled === true,
                plugins: declared as Record<string, never>,
              });
            },
            mutate: async (update) => {
              await mutateConfigFile({
                mutate: (draft) => {
                  // Create the nested plugin config path on demand so codex
                  // plugin commands can enable/update Codex-managed plugins.
                  const root = draft as Record<string, unknown>;
                  const pluginsBlock = (root.plugins ??= {}) as Record<string, unknown>;
                  const entries = (pluginsBlock.entries ??= {}) as Record<string, unknown>;
                  const codexEntry = (entries.codex ??= {}) as Record<string, unknown>;
                  const config = (codexEntry.config ??= {}) as Record<string, unknown>;
                  const codexPlugins = (config.codexPlugins ??= {}) as Record<string, unknown>;
                  codexPlugins.plugins ??= {};
                  update(codexPlugins as CodexPluginsConfigBlock);
                },
              });
            },
          },
        },
      }),
    );
    api.on("inbound_claim", async (event, ctx) => {
      const { handleCodexConversationInboundClaim } = await import("./src/conversation-binding.js");
      return await handleCodexConversationInboundClaim(event, ctx, {
        bindingStore,
        pluginConfig: resolveCurrentPluginConfig(),
        config: resolveCurrentConfig(),
        resumeCodexCliSessionOnNode: async (params) =>
          await (
            await loadNodeCliSessions()
          ).resumeCodexCliSessionOnNode({
            runtime: api.runtime,
            ...params,
          }),
      });
    });
    api.on("after_compaction", async (event, ctx) => {
      const previousSessionId = event.previousSessionId?.trim();
      const sessionId = ctx.sessionId?.trim();
      if (!previousSessionId || !sessionId || previousSessionId === sessionId) {
        return;
      }
      const config = resolveCurrentConfig();
      const sessionKey = ctx.sessionKey?.trim();
      const { sessionBindingIdentity } = await import("./src/app-server/session-binding.js");
      const identity = sessionBindingIdentity({
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        ...(config ? { config } : {}),
      });
      const adopted = await bindingStore.adoptSessionGeneration(identity, previousSessionId);
      if (adopted === "conflict") {
        api.logger.warn?.(
          `codex: could not adopt compacted session generation ${sessionId} (${adopted}); secondary native compaction will skip`,
        );
      }
    });
    api.on("session_end", async (event, ctx) => {
      if (!event.reason || !ENDED_SESSION_REASONS.has(event.reason)) {
        return;
      }
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      const config = resolveCurrentConfig();
      const { sessionBindingIdentity } = await import("./src/app-server/session-binding.js");
      await bindingStore.retireSessionGeneration(
        sessionBindingIdentity({
          sessionId: event.sessionId,
          ...(sessionKey ? { sessionKey } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          ...(config ? { config } : {}),
        }),
      );
    });
  },
});
