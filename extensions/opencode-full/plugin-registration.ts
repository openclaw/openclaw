import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

// OpenCode tools bridged to OpenClaw format
const lspTool = tool({
  description: "Execute LSP operations for code intelligence",
  args: {
    operation: z.enum(["definitions", "references", "symbols", "hover", "completions"]),
    file: z.string().optional(),
    position: z.object({
      line: z.number(),
      character: z.number(),
    }).optional(),
    query: z.string().optional(),
  },
  async execute(args, context) {
    return JSON.stringify({
      operation: args.operation,
      file: args.file,
      position: args.position,
      session: context.sessionID,
      worktree: context.worktree,
    });
  },
});

const refactorTool = tool({
  description: "Automated code refactoring",
  args: {
    type: z.enum(["rename", "extract", "inline", "move", "extract-interface"]),
    target: z.string(),
    newName: z.string().optional(),
    file: z.string(),
  },
  async execute(args, context) {
    return JSON.stringify({
      type: args.type,
      target: args.target,
      newName: args.newName,
      file: args.file,
      session: context.sessionID,
      directory: context.directory,
    });
  },
});

const tddTool = tool({
  description: "Test-driven development workflow",
  args: {
    action: z.enum(["generate-tests", "run-tests", "fix-tests", "coverage"]),
    file: z.string().optional(),
    pattern: z.string().optional(),
  },
  async execute(args, context) {
    return JSON.stringify({
      action: args.action,
      file: args.file,
      pattern: args.pattern,
      session: context.sessionID,
    });
  },
});

const testTool = tool({
  description: "Run and manage tests",
  args: {
    command: z.enum(["run", "watch", "debug", "coverage"]),
    pattern: z.string().optional(),
    file: z.string().optional(),
  },
  async execute(args, context) {
    return JSON.stringify({
      command: args.command,
      pattern: args.pattern,
      file: args.file,
      session: context.sessionID,
    });
  },
});

const reviewTool = tool({
  description: "Code review and analysis",
  args: {
    type: z.enum(["full", "incremental", "diff"]),
    files: z.array(z.string()).optional(),
    focus: z.array(z.string()).optional(),
  },
  async execute(args, context) {
    return JSON.stringify({
      type: args.type,
      files: args.files,
      focus: args.focus,
      session: context.sessionID,
      worktree: context.worktree,
    });
  },
});

const brainstormingTool = tool({
  description: "Creative brainstorming session",
  args: {
    topic: z.string(),
    constraints: z.array(z.string()).optional(),
    iterations: z.number().min(1).max(10).default(3),
  },
  async execute(args, context) {
    return JSON.stringify({
      topic: args.topic,
      constraints: args.constraints,
      iterations: args.iterations,
      session: context.sessionID,
    });
  },
});

const refactorAdvancedTool = tool({
  description: "Advanced refactoring with AI suggestions",
  args: {
    scope: z.enum(["file", "function", "class", "module"]),
    target: z.string(),
    goal: z.string(),
  },
  async execute(args, context) {
    return JSON.stringify({
      scope: args.scope,
      target: args.target,
      goal: args.goal,
      session: context.sessionID,
      directory: context.directory,
    });
  },
});

const debuggingTool = tool({
  description: "Debug and diagnose issues",
  args: {
    type: z.enum(["analyze", "trace", "profile", "explain-error"]),
    target: z.string().optional(),
    errorMessage: z.string().optional(),
  },
  async execute(args, context) {
    return JSON.stringify({
      type: args.type,
      target: args.target,
      errorMessage: args.errorMessage,
      session: context.sessionID,
      directory: context.directory,
    });
  },
});

function opencodeToolToOpenclaw(
  opencodeTool: ReturnType<typeof tool>,
  context: OpenClawPluginToolContext
): AnyAgentTool {
  return {
    name: opencodeTool.description.split(" ")[0].toLowerCase(),
    description: opencodeTool.description,
    schema: opencodeTool.args,
    execute: async (args: Record<string, unknown>) => {
      const result = await opencodeTool.execute(
        args as any,
        {
          sessionID: context.sessionId || "unknown",
          messageID: "openclaw-bridge",
          agent: "opencode-full",
          directory: context.workspaceDir || context.agentDir || process.cwd(),
          worktree: context.workspaceDir || process.cwd(),
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        }
      );
      return result;
    },
  };
}

function createOpencodeToolsFactory(
  ctx: OpenClawPluginToolContext
): AnyAgentTool[] {
  const tools = [
    lspTool,
    refactorTool,
    tddTool,
    testTool,
    reviewTool,
    brainstormingTool,
    refactorAdvancedTool,
    debuggingTool,
];

const opencodeCommands: OpenClawPluginCommandDefinition[] = [
  {
    name: "opencode",
    description: "OpenCode AI assistant commands",
    subcommands: [
      {
        name: "lsp",
        description: "Run LSP operations",
        args: [
          {
            name: "operation",
            type: "string",
            required: true,
            description: "LSP operation (definitions, references, symbols, hover, completions)",
          },
        ],
      },
      {
        name: "refactor",
        description: "Run refactoring operations",
        args: [
          {
            name: "type",
            type: "string",
            required: true,
            description: "Refactor type (rename, extract, inline, move)",
          },
          {
            name: "target",
            type: "string",
            required: true,
            description: "Target to refactor",
          },
        ],
      },
      {
        name: "tdd",
        description: "Test-driven development workflow",
        args: [
          {
            name: "action",
            type: "string",
            required: true,
            description: "TDD action (generate-tests, run-tests, fix-tests)",
          },
        ],
      },
      {
        name: "test",
        description: "Run tests",
        args: [
          {
            name: "command",
            type: "string",
            required: true,
            description: "Test command (run, watch, debug, coverage)",
          },
        ],
      },
      {
        name: "review",
        description: "Code review",
        args: [
          {
            name: "type",
            type: "string",
            required: false,
            description: "Review type (full, incremental, diff)",
          },
        ],
      },
      {
        name: "brainstorm",
        description: "Brainstorming session",
        args: [
          {
            name: "topic",
            type: "string",
            required: true,
            description: "Topic to brainstorm",
          },
        ],
      },
      {
        name: "debug",
        description: "Debug and diagnose",
        args: [
          {
            name: "type",
            type: "string",
            required: true,
            description: "Debug type (analyze, trace, profile, explain-error)",
          },
        ],
      },
    ],
  },
];

export function registerOpencodeFullPlugin(api: OpenClawPluginApi) {
  api.logger.info("Registering OpenCode Full Integration plugin");

  api.registerTool(
    ((ctx: OpenClawPluginToolContext) => createOpencodeToolsFactory(ctx)) as OpenClawPluginToolFactory,
    {
      name: "opencode",
      names: [
        "opencode:lsp",
        "opencode:refactor",
        "opencode:tdd",
        "opencode:test",
        "opencode:review",
        "opencode:brainstorm",
        "opencode:debug",
      ],
    }
  );

  for (const command of opencodeCommands) {
    api.registerCommand(command);
  }

  api.registerHook(
    ["chat.params", "chat.message"],
    async (event) => {
      if (event.type === "chat.params") {
        api.logger.debug("OpenCode session context bridged");
      }
    }
  );

  api.logger.info("OpenCode Full Integration plugin registered successfully");
}
