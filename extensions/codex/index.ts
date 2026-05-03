import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildCodexProvider } from "./provider.js";
import { createCodexCommand, createCodexGoalCommand } from "./src/commands.js";
import {
  type CodexConversationGoalTerminalEvent,
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
} from "./src/conversation-binding.js";
import { buildCodexMigrationProvider } from "./src/migration/provider.js";

const goalTerminalNotificationBySession = new Map<string, string>();

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
    api.registerCommand(createCodexCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createCodexGoalCommand({ pluginConfig: api.pluginConfig }));
    const notifyTerminalGoal = (event: CodexConversationGoalTerminalEvent) => {
      const sessionKey = event.sessionKey?.trim();
      if (!sessionKey) {
        return;
      }
      const fingerprint = buildGoalTerminalFingerprint(event);
      const dedupeKey = `${sessionKey}:${event.threadId}`;
      if (goalTerminalNotificationBySession.get(dedupeKey) === fingerprint) {
        return;
      }
      goalTerminalNotificationBySession.set(dedupeKey, fingerprint);
      const queued = api.runtime.system.enqueueSystemEvent(formatGoalTerminalSystemEvent(event), {
        sessionKey,
        contextKey: `codex-goal:${fingerprint}`,
        trusted: true,
      });
      if (queued) {
        api.runtime.system.requestHeartbeat({
          source: "hook",
          intent: "event",
          reason: "codex_goal_terminal",
          sessionKey,
          heartbeat: { target: "last" },
        });
      }
    };
    api.on("inbound_claim", (event, ctx) =>
      handleCodexConversationInboundClaim(event, ctx, {
        pluginConfig: resolveCurrentPluginConfig(),
        goalCompletion: { onTerminalGoal: notifyTerminalGoal },
      }),
    );
    api.onConversationBindingResolved?.(handleCodexConversationBindingResolved);
  },
});

function buildGoalTerminalFingerprint(event: CodexConversationGoalTerminalEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.threadId,
        event.status,
        event.objective ?? "",
        event.tokensUsed ?? "",
        event.tokenBudget ?? "",
        event.timeUsedSeconds ?? "",
        event.updatedAt ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

function formatGoalTerminalSystemEvent(event: CodexConversationGoalTerminalEvent): string {
  const lines = [
    "Codex native goal terminal event: the bound Codex thread reached a terminal goal state.",
    `Status: ${event.status}`,
  ];
  if (event.objective) {
    lines.push(`Objective: ${event.objective}`);
  }
  if (event.tokensUsed != null || event.tokenBudget !== undefined) {
    lines.push(`Tokens: ${formatGoalTokens(event.tokensUsed, event.tokenBudget)}`);
  }
  if (event.timeUsedSeconds != null) {
    lines.push(`Time used: ${formatDurationSeconds(event.timeUsedSeconds)}`);
  }
  if (event.replyText.trim()) {
    lines.push(`Latest Codex reply: ${event.replyText.trim()}`);
  }
  lines.push(
    "Tell the user briefly that the Codex goal finished or hit its budget, and suggest any obvious next step.",
  );
  return lines.join("\n");
}

function formatGoalTokens(used: number | undefined, budget: number | null | undefined): string {
  const usedText = used == null ? "unknown" : String(used);
  if (budget == null) {
    return budget === null ? `${usedText}/unlimited` : usedText;
  }
  return `${usedText}/${budget}`;
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
