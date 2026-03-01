import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { setFeishuRuntime } from "./runtime.js";

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

function createMockFeishuChannel(cfg: OpenClawPluginApi["config"]) {
  const feishuCfg = cfg?.channels?.feishu as
    | {
        accounts?: Record<
          string,
          { appId?: string; appSecret?: string; tools?: Record<string, boolean> }
        >;
      }
    | undefined;
  const accounts = feishuCfg?.accounts ?? {};
  const ids = Object.keys(accounts).filter(Boolean);
  const accountIds = ids.length > 0 ? ids : ["default"];

  return {
    listFeishuAccountIds: () => accountIds,
    resolveDefaultFeishuAccountId: () => accountIds[0] ?? "default",
    resolveFeishuAccount: ({ accountId }: { accountId?: string }) => {
      const id = accountId ?? "default";
      const acct = accounts[id] ?? {};
      const merged = { ...feishuCfg, ...acct };
      return {
        accountId: id,
        enabled: true,
        configured: Boolean(acct.appId),
        appId: acct.appId,
        appSecret: acct.appSecret,
        domain: "feishu" as const,
        config: merged ?? {},
      };
    },
    probeFeishu: () => Promise.resolve({ ok: true }),
    sendMessageFeishu: () => Promise.resolve({ messageId: "", chatId: "" }),
    getMessageFeishu: () => Promise.resolve(null),
    sendCardFeishu: () => Promise.resolve({ messageId: "", chatId: "" }),
    sendMarkdownCardFeishu: () => Promise.resolve({ messageId: "", chatId: "" }),
    updateCardFeishu: () => Promise.resolve(),
    editMessageFeishu: () => Promise.resolve(),
    buildMarkdownCard: (text: string) => ({
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: text }] },
    }),
  };
}

export function createToolFactoryHarness(cfg: OpenClawPluginApi["config"]) {
  const registered: RegisteredTool[] = [];
  const runtime = {
    version: "test",
    config: {} as OpenClawPluginApi["config"],
    system: {} as OpenClawPluginApi["runtime"]["system"],
    media: {} as OpenClawPluginApi["runtime"]["media"],
    tts: {} as OpenClawPluginApi["runtime"]["tts"],
    tools: {} as OpenClawPluginApi["runtime"]["tools"],
    channel: {
      feishu: createMockFeishuChannel(cfg),
      text: {
        resolveMarkdownTableMode: () => "native" as const,
        convertMarkdownTables: (t: string) => t,
      },
    } as unknown as OpenClawPluginApi["runtime"]["channel"],
    logging: {} as OpenClawPluginApi["runtime"]["logging"],
    state: {} as OpenClawPluginApi["runtime"]["state"],
  };
  setFeishuRuntime(runtime as unknown as OpenClawPluginApi["runtime"]);

  const api: Pick<OpenClawPluginApi, "config" | "logger" | "registerTool" | "runtime"> = {
    config: cfg,
    runtime: runtime as OpenClawPluginApi["runtime"],
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
