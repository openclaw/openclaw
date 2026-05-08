import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallTtsConfig } from "./config.js";

export type CoreConfig = OpenClawConfig & {
  messages?: OpenClawConfig["messages"] & {
    tts?: VoiceCallTtsConfig;
  };
};

export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
