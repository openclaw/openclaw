import type { AnyAgentTool } from "../pi-tools.types.js";
import { feishuChatMapper } from "./mappers/feishu-chat.js";
import { sessionMacroMapper } from "./mappers/session.js";
import { defaultGenericParser } from "./mappers/types.js";

// Session-aware tool stash to bridge from the Agent's in-memory tool array to the RPC Daemon
const sessionTools = new Map<string, Map<string, AnyAgentTool>>();

// Registry of custom mappers to override generic behavior
const customMappers = new Map<string, typeof feishuChatMapper>([
  [feishuChatMapper.commandKey, feishuChatMapper],
]);

// Registry of macro mappers that take over a top-level command and route to underlying tools
export const macroMappers = new Map<string, typeof sessionMacroMapper>([
  [sessionMacroMapper.commandKey, sessionMacroMapper],
]);

export function getCustomMapper(cliCommandKey: string) {
  return customMappers.get(cliCommandKey);
}

/**
 * Stashes the instantiated tools for a specific session.
 * We convert tool names like `agents_list` or `feishu_update` into CLI subcommands
 * like `agents list` or `feishu update`.
 */
export function stashSessionTools(sessionKey: string, tools: AnyAgentTool[]) {
  const toolMap = new Map<string, AnyAgentTool>();
  for (const tool of tools) {
    // e.g. "agents_list" -> "agents list", "feishu_update" -> "feishu update"
    const cliKey = tool.name.replace(/_/g, " ");
    toolMap.set(cliKey, tool);
    // Also keep the original name just in case
    toolMap.set(tool.name, tool);
  }
  sessionTools.set(sessionKey, toolMap);
}

export function getStashedTools(sessionKey: string) {
  return sessionTools.get(sessionKey);
}

export function resolveCommand(sessionKey: string, args: string[]) {
  const toolMap = getStashedTools(sessionKey);
  if (!toolMap) {
    return null;
  }

  // 1. Check Macro Mappers first (e.g. "session")
  if (args.length >= 1) {
    const macro = macroMappers.get(args[0] || "");
    if (macro) {
      const resolved = macro.resolveMacro(args.slice(1), toolMap);
      if (resolved) {
        return resolved;
      }
    }
  }

  // 2. Try 2-part commands (e.g., "feishu update")
  if (args.length >= 2) {
    const key = `${args[0]} ${args[1]}`;
    const tool = toolMap.get(key);
    if (tool) {
      const mapper = getCustomMapper(key);
      return {
        tool,
        commandArgs: mapper ? mapper.parseArgs(args.slice(2)) : defaultGenericParser(args.slice(2)),
      };
    }
  }

  // 3. Try 1-part commands (e.g., "subagents")
  if (args.length >= 1) {
    const key = args[0] || "";
    const tool = toolMap.get(key);
    if (tool) {
      const mapper = getCustomMapper(key);
      return {
        tool,
        commandArgs: mapper ? mapper.parseArgs(args.slice(1)) : defaultGenericParser(args.slice(1)),
      };
    }
  }
  return null;
}
