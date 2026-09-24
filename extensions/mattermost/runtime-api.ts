// Private runtime entry and shared type imports for the bundled Mattermost plugin.
export type {
  ChannelGroupContext,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
export { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
export { setMattermostRuntime } from "./src/runtime.js";
