import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallTtsConfig } from "./config.js";

export type CoreConfig = {
  /** Core session config used to locate persisted voice response sessions. */
  session?: {
    store?: string;
  };
  /** Core TTS config that voice-call can merge with route-specific overrides. */
  messages?: {
    tts?: VoiceCallTtsConfig;
  };
  [key: string]: unknown;
};

/** Agent runtime capabilities injected from the host OpenClaw plugin API. */
export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
