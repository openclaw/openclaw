import type { AnyAgentTool } from "../../pi-tools.types.js";
import { defaultGenericParser } from "./types.js";

/**
 * Macro Mapper for Session Management
 * Merges 6 underlying OpenClaw tools into a single cohesive CLI command: `openclaw-tool session`
 *
 * Target Tools:
 * - sessions_list
 * - session_status
 * - sessions_history
 * - sessions_send
 * - sessions_spawn
 * - subagents
 */
export const sessionMacroMapper = {
  commandKey: "session",

  // This mapper doesn't just parse args, it decides WHICH tool to route to based on the args
  resolveMacro: (args: string[], availableTools: Map<string, AnyAgentTool>) => {
    let targetToolName = "sessions_list"; // default
    let parsedArgs: Record<string, unknown> = {};

    if (args.length === 0) {
      targetToolName = "sessions_list";
    } else if (args[0] && !args[0].startsWith("-")) {
      // First argument is a session ID (e.g. `openclaw-tool session xxx`)
      const sessionId = args[0];
      const remainingArgs = args.slice(1);
      const genericFlags = defaultGenericParser(remainingArgs);

      if (genericFlags["log"] || genericFlags["history"]) {
        targetToolName = "sessions_history";
        parsedArgs = { session_id: sessionId, ...genericFlags };
        delete parsedArgs["log"];
        delete parsedArgs["history"];
      } else if (genericFlags["send"]) {
        targetToolName = "sessions_send";
        parsedArgs = { session_id: sessionId, message: genericFlags["send"], ...genericFlags };
        delete parsedArgs["send"];
      } else {
        targetToolName = "session_status";
        parsedArgs = { session_id: sessionId };
      }
    } else {
      // Flags without a session ID
      const genericFlags = defaultGenericParser(args);
      if (genericFlags["subagents"]) {
        targetToolName = "subagents";
      } else if (genericFlags["spawn"]) {
        targetToolName = "sessions_spawn";
        parsedArgs = { ...genericFlags };
        delete parsedArgs["spawn"];
      } else {
        targetToolName = "sessions_list";
        parsedArgs = { ...genericFlags };
      }
    }

    const tool = availableTools.get(targetToolName);
    if (!tool) {
      return null;
    }

    return {
      tool,
      commandArgs: parsedArgs,
    };
  },

  generateHelp: () => {
    return `Usage: openclaw-tool session [session_id] [options]

Session management and communication tool.

Without session_id:
  (no args)             List your active and recent sessions
  --subagents           List all sub-agents spawned by the current session
  --spawn --agent <id>  Spawn a new sub-agent in the background
  --limit <number>      Limit the number of listed sessions

With session_id:
  <session_id>          Get realtime status of the specified session
  --log, --history      Retrieve the message transcript/history
  --send <message>      Send a message to the session
  --since_message <id>  (Use with --log) Fetch history since a specific message ID

Examples:
  openclaw-tool session
  openclaw-tool session --subagents
  openclaw-tool session sess_12345
  openclaw-tool session sess_12345 --log --limit 10
  openclaw-tool session sess_12345 --send "Please review the new files"
`;
  },
};
