import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";

type ToolContextLike = {
  agentAccountId?: string;
};

type ToolFactoryLike = (ctx: ToolContextLike) => AnyAgentTool | AnyAgentTool[] | null | undefined;

export type ToolLike = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown> | unknown;
};

type RegisteredTool = {
  tool: AnyAgentTool | ToolFactoryLike;
  opts?: { name?: string };
};

function toToolList(value: AnyAgentTool | AnyAgentTool[] | null | undefined): AnyAgentTool[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function asToolLike(tool: AnyAgentTool, fallbackName?: string): ToolLike {
  const candidate = tool as Partial<ToolLike>;
  const name = candidate.name ?? fallbackName;
  const execute = candidate.execute;
  if (!name || typeof execute !== "function") {
    throw new Error(`Resolved tool is missing required fields (name=${String(name)})`);
  }
  return {
    name,
    execute: (toolCallId, params) => execute(toolCallId, params),
  };
}

export function createToolFactoryHarness(cfg: OpenClawPluginApi["config"]) {
  const registered: RegisteredTool[] = [];

  const api: Pick<OpenClawPluginApi, "config" | "logger" | "registerTool"> = {
    config: cfg,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerTool: (tool, opts) => {
      registered.push({ tool, opts });
    },
  };

  const resolveTool = (name: string, ctx: ToolContextLike = {}): ToolLike => {
    for (const entry of registered) {
      if (entry.opts?.name === name && typeof entry.tool !== "function") {
        return asToolLike(entry.tool, name);
      }

      if (typeof entry.tool === "function") {
        const builtTools = toToolList(entry.tool(ctx));
        const hit = builtTools.find((tool) => (tool as { name?: string }).name === name);
        if (hit) {
          return asToolLike(hit, name);
        }
      } else if ((entry.tool as { name?: string }).name === name) {
        return asToolLike(entry.tool, name);
      }
    }
    throw new Error(`Tool not registered: ${name}`);
  };

  return {
    api: api as OpenClawPluginApi,
    resolveTool,
  };
}
