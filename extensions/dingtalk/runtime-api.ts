// Private runtime barrel for the bundled DingTalk extension.
// Keep this barrel thin: only re-export the runtime setter that the host
// channel-entry contract calls during `setChannelRuntime`. Heavy plugin-sdk
// imports stay in `src/` modules so this file loads cheaply during bootstrap.

export type {
  ChannelPlugin,
  ClawdbotConfig,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk";

export { setDingtalkRuntime } from "./src/runtime.js";
