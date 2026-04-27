import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { CodexCommandDeps } from "./command-handlers.js";

export function createCodexCommand(options: {
  pluginConfig?: unknown;
  deps?: Partial<CodexCommandDeps>;
}): OpenClawPluginCommandDefinition {
  return {
    name: "codex",
    description: "Inspect and control the Codex app-server harness",
    agentPromptGuidance: [
      "Native Codex app-server plugin is available (`/codex ...`). For Codex bind/control/thread/resume/steer/stop requests, prefer `/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`, and `/codex stop` over ACP.",
      "Use ACP for Codex only when the user explicitly asks for ACP/acpx or wants to test the ACP path.",
    ],
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCodexCommand(ctx, options),
  };
}

export function createCodexDiagnosticsCommand(options: {
  pluginConfig?: unknown;
  deps?: Partial<CodexCommandDeps>;
}): OpenClawPluginCommandDefinition {
  return {
    name: "diagnostics",
    description: "Send Codex diagnostics feedback for the current thread",
    agentPromptGuidance: [
      "When a Codex harness run misbehaves, `/diagnostics [note]` sends the current Codex thread's feedback bundle to OpenAI and returns a `codex resume <thread-id>` CLI inspection hint.",
    ],
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCodexDiagnosticsPluginCommand(ctx, options),
  };
}

export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> } = {},
): Promise<PluginCommandResult> {
  const { handleCodexSubcommand } = await import("./command-handlers.js");
  return await handleCodexSubcommand(ctx, options);
}

export async function handleCodexDiagnosticsPluginCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> } = {},
): Promise<PluginCommandResult> {
  const { handleCodexDiagnosticsCommand } = await import("./command-handlers.js");
  return await handleCodexDiagnosticsCommand(ctx, options);
}
