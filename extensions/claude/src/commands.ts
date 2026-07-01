/**
 * /claude slash command — inspect and control the Claude app-server harness.
 *
 * Mirrors extensions/codex/src/commands.ts. Subcommands:
 *   - status         show shared-client liveness + recent error context
 *   - version        report bridge + installed server package versions
 *   - threads        list .claude-binding.json files for the active session
 *   - resume <id>    rotate the current session's binding to a given thread_id
 *   - help           print subcommand listing
 *
 * The bridge client is shared per host process (see app-server/client.ts).
 * Commands that need to spawn the server intentionally avoid doing so —
 * they probe the shared client without forcing a start, so /claude status
 * remains cheap when no turn has run yet.
 */

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";

type ClaudeCommandOptions = {
  pluginConfig?: unknown;
};

export function createClaudeCommand(
  options: ClaudeCommandOptions = {},
): OpenClawPluginCommandDefinition {
  return {
    name: "claude",
    description: "Inspect and control the Claude app-server harness",
    ownership: "reserved",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleClaudeCommand(ctx, options),
  };
}

const SUBCOMMANDS = ["status", "version", "threads", "resume", "help"] as const;
type ClaudeSubcommand = (typeof SUBCOMMANDS)[number];

function parseSubcommand(raw: string | undefined): {
  sub: ClaudeSubcommand;
  rest: string;
} {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { sub: "help", rest: "" };
  }
  const [head, ...tail] = trimmed.split(/\s+/);
  const candidate = (head ?? "").toLowerCase();
  if ((SUBCOMMANDS as readonly string[]).includes(candidate)) {
    return { sub: candidate as ClaudeSubcommand, rest: tail.join(" ") };
  }
  return { sub: "help", rest: trimmed };
}

export async function handleClaudeCommand(
  ctx: PluginCommandContext,
  _options: ClaudeCommandOptions = {},
): Promise<PluginCommandResult> {
  const { sub, rest } = parseSubcommand(ctx.args);
  try {
    const handlers = await loadHandlers();
    switch (sub) {
      case "status":
        return handlers.handleStatus(ctx);
      case "version":
        return await handlers.handleVersion(ctx);
      case "threads":
        return await handlers.handleThreads(ctx);
      case "resume":
        return await handlers.handleResume(ctx, rest);
      default:
        return handlers.handleHelp();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Claude command failed: ${message}` };
  }
}

async function loadHandlers() {
  // Lazy-import: keep slash-command registration cheap until invoked.
  const mod = await import("./command-handlers.js");
  return mod;
}
