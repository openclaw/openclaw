import { createAgentsListTool } from "../tools/agents-list-tool.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createSessionsListTool } from "../tools/sessions-list-tool.js";

// A simple registry mapping CLI arguments to the underlying OpenClaw tools.
export const OPENCLAW_TOOL_REGISTRY: Record<
  string,
  {
    factory: (opts: { agentSessionKey?: string }) => AnyAgentTool;
    parseArgs: (args: string[]) => Record<string, unknown>;
  }
> = {
  "agents list": {
    factory: createAgentsListTool,
    parseArgs: (_args) => {
      // openclaw-tool agents list doesn't take parameters yet
      return {};
    },
  },
  "sessions list": {
    factory: createSessionsListTool as unknown as (opts: {
      agentSessionKey?: string;
    }) => AnyAgentTool,
    parseArgs: (args) => {
      // rudimentary argument parsing for prototyping
      const params: Record<string, unknown> = {};
      const limitIdx = args.indexOf("--limit");
      if (limitIdx >= 0 && args[limitIdx + 1]) {
        params.limit = parseInt(args[limitIdx + 1], 10);
      }
      return params;
    },
  },
};

export function resolveCommand(args: string[]) {
  // Try to match 2-part commands (e.g. "agents list")
  if (args.length >= 2) {
    const key = `${args[0]} ${args[1]}`;
    if (OPENCLAW_TOOL_REGISTRY[key]) {
      return {
        key,
        toolDef: OPENCLAW_TOOL_REGISTRY[key],
        commandArgs: args.slice(2),
      };
    }
  }
  // Try to match 1-part commands
  if (args.length >= 1) {
    const key = args[0];
    if (OPENCLAW_TOOL_REGISTRY[key]) {
      return {
        key,
        toolDef: OPENCLAW_TOOL_REGISTRY[key],
        commandArgs: args.slice(1),
      };
    }
  }
  return null;
}
