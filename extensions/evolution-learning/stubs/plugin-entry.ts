/**
 * openclaw/plugin-sdk/plugin-entry 的最小化 Mock
 * 供 test-harness.ts 在無真實 SDK 的情況下載入 index.ts
 */

export type AnyAgentTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (chunk: string) => void,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
};

export type OpenClawPluginApi = {
  on: (
    event: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>,
    options?: { priority?: number; timeoutMs?: number },
  ) => void;
  registerTool: (tool: AnyAgentTool) => void;
  registerService: (service: {
    id: string;
    start: (ctx: { workspaceDir?: string; stateDir: string }) => Promise<void>;
    stop?: (ctx: { workspaceDir?: string; stateDir: string }) => void | Promise<void>;
  }) => void;
  registerCommand: (cmd: {
    name: string;
    description?: string;
    execute?: (args: string[]) => Promise<string>;
  }) => void;
  /** 掛載 CLI 子指令到 OpenClaw CLI（openclaw <name> <subcommand>）*/
  registerCli: (
    register: (ctx: { program: { command: (name: string) => unknown } }) => Promise<void>,
    options?: {
      descriptors?: Array<{ name: string; description: string; hasSubcommands?: boolean }>;
    },
  ) => void;
};

export type PluginEntry = {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
};

/** 直接回傳 entry，不做任何包裝 */
export function definePluginEntry(entry: PluginEntry): PluginEntry {
  return entry;
}
