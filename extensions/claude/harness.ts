/**
 * AgentHarness factory for the Claude extension. Mirrors the shape of
 * createCodexAppServerAgentHarness so OpenClaw's dispatch treats Claude as
 * a peer of Codex: dynamic-imported runAttempt, optional dispose, supports
 * advertised for the `anthropic` provider only.
 *
 * deliveryDefaults is intentionally unset: with dynamicTools wired (which
 * the in-tree promotion enables), Claude CAN call OpenClaw's `message` tool,
 * but operators may still prefer "automatic" delivery. We leave it to the
 * messages.visibleReplies config rather than locking it here.
 */

import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";
import { claudeAppServerPoolKey, resolveClaudeAppServerConfig } from "./src/app-server/config.js";

const DEFAULT_CLAUDE_PROVIDER_IDS = new Set(["anthropic"]);

export function createClaudeAppServerAgentHarness(options?: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  poolKey?: string;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
}): AgentHarness {
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_CLAUDE_PROVIDER_IDS)].map((id) => id.trim().toLowerCase()),
  );
  // Each bridge-backed extension owns exactly one shared-client pool slot,
  // keyed by its provider identity (client.ts / run-attempt.ts). dispose()
  // must clear ONLY that slot: clearing the whole pool would tear down a
  // co-installed sibling extension's live bridge process on reload/disable
  // (e.g. reloading claude would kill glm-bridge, openclaw-91t).
  //
  // Resolved at DISPOSE TIME (not once at construction) when a plugin config
  // is available, via the exact same resolveClaudeAppServerConfig path
  // run-attempt.ts uses per turn — so if an operator's config sets
  // appServer.modelProvider to something other than providerIds[0] (an
  // unusual but legal override), dispose() still clears the slot a real turn
  // would actually have used, instead of a providerIds-derived guess that
  // could drift from it. Falls back to providerIds[0] when no plugin config
  // getter is available at all (e.g. a bare factory call in tests), and an
  // explicit poolKey always wins outright.
  const resolvePoolKey = (): string => {
    if (options?.poolKey) {
      return options.poolKey;
    }
    if (options?.resolvePluginConfig || options?.pluginConfig !== undefined) {
      const cfg = resolveClaudeAppServerConfig(
        options?.resolvePluginConfig?.() ?? options?.pluginConfig,
      );
      return claudeAppServerPoolKey(cfg.appServer.modelProvider);
    }
    return claudeAppServerPoolKey([...providerIds][0]);
  };
  return {
    id: options?.id ?? "claude-bridge",
    label: options?.label ?? "Claude app-server harness",
    supports: (ctx) => {
      const provider = ctx.provider.trim().toLowerCase();
      if (providerIds.has(provider)) {
        return { supported: true, priority: 100 };
      }
      return {
        supported: false,
        reason: `provider is not one of: ${[...providerIds].toSorted().join(", ")}`,
      };
    },
    runAttempt: async (params) => {
      const { runClaudeAppServerAttempt } = await import("./src/app-server/run-attempt.js");
      return runClaudeAppServerAttempt(params, {
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
      });
    },
    reset: async (params) => {
      if (params.sessionFile) {
        const { clearClaudeAppServerBinding } = await import("./src/app-server/thread-store.js");
        await clearClaudeAppServerBinding(params.sessionFile);
      }
    },
    dispose: async () => {
      const { clearSharedClaudeAppServerClient } = await import("./src/app-server/client.js");
      await clearSharedClaudeAppServerClient(resolvePoolKey());
    },
  };
}
