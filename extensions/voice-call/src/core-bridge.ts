// Voice Call plugin module implements core bridge behavior.
import type { OpenClawPluginApi } from "../api.js";
<<<<<<< HEAD
import type { VoiceCallCoreSessionConfig, VoiceCallTtsConfig } from "./config.js";
=======
import type { VoiceCallTtsConfig } from "./config.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

// Narrow core runtime/config contracts consumed by the voice-call plugin.

/** Core config subset read by voice-call helpers. */
export type CoreConfig = {
<<<<<<< HEAD
  session?: VoiceCallCoreSessionConfig & { store?: string };
=======
  session?: {
    store?: string;
  };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  messages?: {
    tts?: VoiceCallTtsConfig;
  };
  [key: string]: unknown;
};

/** Agent runtime API subset exposed through the plugin SDK. */
export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
