import type { AnyAgentTool } from "../pi-tools.types.js";

// Session-aware tool stash to bridge from the Agent's in-memory tool array to the RPC Daemon
const sessionTools = new Map<string, Map<string, AnyAgentTool>>();

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

/**
 * Super lightweight CLI argument parser.
 * Converts `--key value` and `--flag` into a JSON object.
 */
function parseGenericArgs(args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg && arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1]?.startsWith("--")) {
        // Look ahead for value
        const val = args[i + 1];
        // simple type coercion
        if (val === "true") {
          params[key] = true;
        } else if (val === "false") {
          params[key] = false;
        } else if (!Number.isNaN(Number(val)) && val?.trim() !== "") {
          params[key] = Number(val);
        } else {
          params[key] = val;
        }
        i++; // skip value
      } else {
        // boolean flag
        params[key] = true;
      }
    }
  }
  return params;
}

export function resolveCommand(sessionKey: string, args: string[]) {
  const toolMap = getStashedTools(sessionKey);
  if (!toolMap) {
    return null;
  }

  // Try 2-part commands first (e.g., "feishu update")
  if (args.length >= 2) {
    const key = `${args[0]} ${args[1]}`;
    const tool = toolMap.get(key);
    if (tool) {
      return {
        tool,
        commandArgs: parseGenericArgs(args.slice(2)),
      };
    }
  }

  // Try 1-part commands (e.g., "subagents")
  if (args.length >= 1) {
    const key = args[0];
    const tool = toolMap.get(key ?? "");
    if (tool) {
      return {
        tool,
        commandArgs: parseGenericArgs(args.slice(1)),
      };
    }
  }

  return null;
}
