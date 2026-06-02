import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

/** Runtime state capability shared by the voice-call CLI, runtime, webhook, and manager. */
export type VoiceCallStateRuntime = Pick<PluginRuntime, "state">;

// The store is optional for tests and degraded CLI paths, but initialized runtime paths
// use it as the canonical persisted-state bridge for call records.
const {
  setRuntime: setVoiceCallStateRuntime,
  clearRuntime: clearVoiceCallStateRuntime,
  tryGetRuntime: getOptionalVoiceCallStateRuntime,
} = createPluginRuntimeStore<VoiceCallStateRuntime>({
  pluginId: "voice-call-state",
  errorMessage: "Voice Call state runtime not initialized",
});

export { clearVoiceCallStateRuntime, getOptionalVoiceCallStateRuntime, setVoiceCallStateRuntime };
