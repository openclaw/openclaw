// Private runtime barrel for the bundled Feishu extension.
// Keep this barrel thin and generic-only.

export type {
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelPlugin,
  HistoryEntry,
  OpenClawConfig,
  OpenClawPluginApi,
  OutboundIdentity,
  PluginRuntime,
  ReplyPayload,
} from "openclaw/plugin-sdk/core";
export type { OpenClawConfig as ClawdbotConfig } from "openclaw/plugin-sdk/core";
export type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};
export {
  evaluateSupplementalContextVisibility,
  resolveChannelContextVisibilityMode,
} from "openclaw/plugin-sdk/context-visibility-runtime";
export { normalizeAgentId } from "openclaw/plugin-sdk/routing";
export { setFeishuRuntime } from "./src/runtime.js";
