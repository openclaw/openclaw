import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { describeControlFailure } from "./app-server/capabilities.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import type { CodexCommandDeps } from "./command-handlers.js";

export function createCodexCommand(options: {
  pluginConfig?: unknown;
  deps?: Partial<CodexCommandDeps>;
}): OpenClawPluginCommandDefinition {
  return {
    name: "codex",
    description: "Inspect and control the Codex app-server harness",
    ownership: "reserved",
    agentPromptGuidance: [
      "Native Codex app-server plugin is available (`/codex ...`). For Codex bind/control/thread/resume/steer/stop requests, prefer `/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`, and `/codex stop` over ACP.",
      "For Codex thread goals in a bound conversation, use `/goal ...` or `/codex goal ...` instead of emulating goal state in chat.",
      "Use ACP for Codex only when the user explicitly asks for ACP/acpx or wants to test the ACP path.",
    ],
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCodexCommand(ctx, options),
  };
}

export function createCodexGoalCommand(options: {
  pluginConfig?: unknown;
  deps?: Partial<CodexCommandDeps>;
}): OpenClawPluginCommandDefinition {
  return {
    name: "goal",
    description: "Inspect and control the bound Codex thread goal",
    agentPromptGuidance: [
      "When a conversation is bound to native Codex, `/goal` controls the Codex app-server thread goal. Use `/codex bind` first if no Codex thread is attached.",
    ],
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCodexGoalCommand(ctx, options),
  };
}

export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> } = {},
): Promise<PluginCommandResult> {
  const { handleCodexSubcommand } = await import("./command-handlers.js");
  try {
    return await handleCodexSubcommand(ctx, options);
  } catch (error) {
    return {
      text: `Codex command failed: ${formatCodexDisplayText(describeControlFailure(error))}`,
    };
  }
}

export async function handleCodexGoalCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> } = {},
): Promise<PluginCommandResult> {
  const { handleCodexGoalSubcommand } = await import("./command-handlers.js");
  return await handleCodexGoalSubcommand(ctx, options);
}
