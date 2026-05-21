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

const DEFAULT_CLAUDE_PROVIDER_IDS = new Set(["anthropic"]);

export function createClaudeAppServerAgentHarness(options?: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
}): AgentHarness {
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_CLAUDE_PROVIDER_IDS)].map((id) => id.trim().toLowerCase()),
  );
  return {
    id: options?.id ?? "claude-app-server",
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
      await clearSharedClaudeAppServerClient();
    },
  };
}
