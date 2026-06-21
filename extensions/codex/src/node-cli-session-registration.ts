import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";

export const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";
export const CODEX_CLI_SESSION_RESUME_COMMAND = "codex.cli.session.resume";

export function createCodexCliSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CODEX_CLI_SESSIONS_LIST_COMMAND,
      cap: "codex-cli-sessions",
      handle: async (paramsJSON) =>
        await (await import("./node-cli-sessions.js")).listLocalCodexCliSessions(paramsJSON),
    },
    {
      command: CODEX_CLI_SESSION_RESUME_COMMAND,
      cap: "codex-cli-sessions",
      dangerous: true,
      handle: async (paramsJSON) =>
        await (await import("./node-cli-sessions.js")).resumeLocalCodexCliSession(paramsJSON),
    },
  ];
}

export function createCodexCliSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CODEX_CLI_SESSIONS_LIST_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (ctx) => ctx.invokeNode(),
    },
    {
      commands: [CODEX_CLI_SESSION_RESUME_COMMAND],
      dangerous: true,
      handle: (ctx) => ctx.invokeNode(),
    },
  ];
}
