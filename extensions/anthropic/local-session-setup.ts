// Operator-facing setup facts for the Claude Code channel bridge. The CLI
// prints these; nothing here touches the filesystem so the description stays
// accurate whether or not Claude Code is installed yet.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveClaudeChannelBridgeEndpoint } from "./local-session-bridge.js";

const CLAUDE_CHANNEL_SERVER_NAME = "openclaw";
const CLAUDE_CHANNEL_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;

export type ClaudeLocalSessionSetup = {
  /** Socket (named pipe on Windows) the channel server and hooks connect to. */
  bridgeEndpoint: string;
  channelServerPath: string;
  hookScriptPath: string;
  /** `mcpServers` entry for `.mcp.json` or `~/.claude.json`. */
  mcpServerEntry: { command: string; args: string[] };
  /** `hooks` entry for `~/.claude/settings.json` (or a project `.claude/settings.json`). */
  hooksEntry: Record<string, Array<{ hooks: Array<{ type: "command"; command: string }> }>>;
  commands: { addMcpServer: string; launchClaude: string };
};

/** Resolve a shipped channel artifact next to this module (source tree or dist). */
function resolveClaudeChannelArtifact(fileName: string): string {
  return fileURLToPath(new URL(`./claude-channel/${fileName}`, import.meta.url));
}

export function describeClaudeLocalSessionSetup(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeLocalSessionSetup {
  const channelServerPath = resolveClaudeChannelArtifact("openclaw-channel-server.mjs");
  const hookScriptPath = resolveClaudeChannelArtifact("openclaw-channel-hook.mjs");
  const hookCommand = `node ${JSON.stringify(hookScriptPath)}`;
  return {
    bridgeEndpoint: resolveClaudeChannelBridgeEndpoint(env),
    channelServerPath,
    hookScriptPath,
    mcpServerEntry: { command: "node", args: [channelServerPath] },
    hooksEntry: Object.fromEntries(
      CLAUDE_CHANNEL_HOOK_EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: "command" as const, command: hookCommand }] }],
      ]),
    ),
    commands: {
      addMcpServer: `claude mcp add --scope user ${CLAUDE_CHANNEL_SERVER_NAME} -- node ${JSON.stringify(channelServerPath)}`,
      launchClaude: `claude --dangerously-load-development-channels server:${CLAUDE_CHANNEL_SERVER_NAME}`,
    },
  };
}

const execFileAsync = promisify(execFile);
const CLAUDE_MCP_ADD_TIMEOUT_MS = 20_000;

function resolveClaudeSettingsPath(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(
    configDir ? path.resolve(configDir) : path.join(os.homedir(), ".claude"),
    "settings.json",
  );
}

/**
 * `openclaw connect --share claude` on this machine: install the hooks Claude Code
 * needs into the user's settings (merged, idempotent) and register the channel
 * server with `claude mcp add`. Returns what happened for the terminal.
 */
export async function enableClaudeLocalSharing(params: {
  env: NodeJS.ProcessEnv;
  runClaude?: (args: string[]) => Promise<void>;
}): Promise<string[]> {
  const setup = describeClaudeLocalSessionSetup(params.env);
  const notes: string[] = [];
  const settingsPath = resolveClaudeSettingsPath(params.env);
  let settings: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  if (raw !== undefined) {
    // A file we cannot parse is the person's; never replace it with ours.
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(
        `${settingsPath} is not a JSON object; fix it before sharing Claude sessions`,
      );
    }
    settings = parsed;
  }
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  let hooksChanged = false;
  for (const [event, entries] of Object.entries(setup.hooksEntry)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const installed = existing.some(
      (entry) =>
        isRecord(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (hook) =>
            isRecord(hook) &&
            typeof hook.command === "string" &&
            hook.command.includes(setup.hookScriptPath),
        ),
    );
    if (!installed) {
      hooks[event] = [...existing, ...entries];
      hooksChanged = true;
    }
  }
  if (hooksChanged) {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
    notes.push(`installed Claude Code hooks in ${settingsPath}`);
  } else {
    notes.push(`Claude Code hooks already present in ${settingsPath}`);
  }
  const mcpArgs = [
    "mcp",
    "add",
    "--scope",
    "user",
    CLAUDE_CHANNEL_SERVER_NAME,
    "--",
    "node",
    setup.channelServerPath,
  ];
  const runClaude =
    params.runClaude ??
    (async (args: string[]) => {
      await execFileAsync("claude", args, { env: params.env, timeout: CLAUDE_MCP_ADD_TIMEOUT_MS });
    });
  try {
    await runClaude(mcpArgs);
    notes.push(
      `registered the ${CLAUDE_CHANNEL_SERVER_NAME} channel with Claude Code (user scope)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(
      /already exists/iu.test(message)
        ? `the ${CLAUDE_CHANNEL_SERVER_NAME} channel is already registered with Claude Code`
        : `could not register the channel with Claude Code (${message.split("\n")[0]}); run: ${setup.commands.addMcpServer}`,
    );
  }
  notes.push(`start Claude Code with: ${setup.commands.launchClaude}`);
  return notes;
}
