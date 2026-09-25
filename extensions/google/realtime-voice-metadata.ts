import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { GOOGLE_PREBUILT_VOICES } from "./voice-catalog.js";

export const GOOGLE_REALTIME_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

export const GOOGLE_REALTIME_VOICE_METADATA = {
  id: "google",
  label: "Google Live Voice",
  defaultModel: GOOGLE_REALTIME_DEFAULT_MODEL,
  voices: GOOGLE_PREBUILT_VOICES,
  autoSelectOrder: 20,
} satisfies Pick<
  RealtimeVoiceProviderPlugin,
  "id" | "label" | "defaultModel" | "voices" | "autoSelectOrder"
>;
