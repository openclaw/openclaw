import type { AnyAgentTool } from "../../pi-tools.types.js";
import { defaultGenericParser } from "./types.js";

/**
 * Custom mapper for feishu_chat
 * Transforms: openclaw-tool feishu chat info <chat_id>
 * Back to: { action: "info", chat_id: "<chat_id>" }
 */
export const feishuChatMapper = {
  commandKey: "feishu chat",
  parseArgs: (args: string[]) => {
    // If it uses traditional generic flags, fallback to generic parser
    if (args.includes("--action")) {
      return defaultGenericParser(args);
    }

    // Git-style subcommand parsing: `openclaw-tool feishu chat info 12345`
    const action = args[0];
    const chatId = args[1];
    const params: Record<string, unknown> = {
      action,
      chat_id: chatId,
    };

    // Parse remaining options (like --page_size) using generic parser
    const remainingArgs = args.slice(2);
    Object.assign(params, defaultGenericParser(remainingArgs));

    return params;
  },
  generateHelp: (tool: AnyAgentTool, cliCommand: string) => {
    return `Usage: openclaw-tool ${cliCommand} <action> <chat_id> [options]

Feishu chat operations.

Actions:
  info       - Get chat information
  members    - List members of the chat

Arguments:
  <action>   The action to perform (info or members)
  <chat_id>  The target Chat ID

Options:
  --page_size <number>    Page size (1-100, default 50)
  --page_token <string>   Pagination token
  --member_id_type <str>  Member ID type (default: open_id)

Examples:
  openclaw-tool feishu chat info oc_123456
  openclaw-tool feishu chat members oc_123456 --page_size 20
`;
  },
};
