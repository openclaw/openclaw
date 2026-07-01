// Google API module exposes the plugin public contract.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { shouldEnableGoogleGeminiCliHarness } from "./gemini-cli-harness-policy.js";
import { createGoogleVertexProvider } from "./provider-contract-api.js";

export default definePluginEntry({
  id: "google",
  name: "Google Setup",
  description: "Lightweight Google setup hooks",
  register(api) {
    api.registerProvider(createGoogleVertexProvider());
    if (shouldEnableGoogleGeminiCliHarness()) {
      api.registerCliBackend(buildGoogleGeminiCliBackend());
    }
  },
});
