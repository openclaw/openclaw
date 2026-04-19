import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { speechHandsMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  id: "speech-hands",
  name: "Speech-Hands Self-Reflection ASR",
  description:
    "Voice-input media-understanding provider that fuses an internal omni-LLM with an external ASR via self-reflection (ACL 2026).",
  register(api) {
    api.registerMediaUnderstandingProvider(speechHandsMediaUnderstandingProvider);
  },
});
