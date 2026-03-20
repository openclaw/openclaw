export type { OpenClawPluginApi, AnyAgentTool, ChannelPlugin } from "openclaw/plugin-sdk/core";
export { definePluginEntry } from "openclaw/plugin-sdk/core";

// Re-export tool factory type (not in core, but used for tool registration)
// Inlined from plugins/types.ts to avoid cross-package import
export type OpenClawPluginToolFactory = (ctx: {
  sandboxed: boolean;
  [key: string]: unknown;
}) => unknown | null;
