import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_SESSIONS_CAPABILITY,
  CLAUDE_SESSIONS_LIST_COMMAND,
  ClaudeCatalogParamsError,
  claudeProjectsAvailable,
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
} from "./session-catalog.js";

function parseNodeParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new ClaudeCatalogParamsError("Claude session parameters must be valid JSON", {
      cause: error,
    });
  }
}

export function createClaudeSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CLAUDE_SESSIONS_LIST_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        JSON.stringify(await listLocalClaudeSessionPage(parseNodeParams(paramsJSON))),
    },
    {
      command: CLAUDE_SESSION_READ_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        JSON.stringify(await readLocalClaudeTranscriptPage(parseNodeParams(paramsJSON))),
    },
  ];
}

export function createClaudeSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_SESSION_READ_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    },
  ];
}
