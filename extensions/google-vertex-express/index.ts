import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGoogleVertexExpressProvider } from "./provider.js";

export default definePluginEntry({
  id: "google-vertex-express",
  name: "Google Vertex AI (Express Mode)",
  description:
    "Provides Google Gemini models via the Vertex AI Express Mode global endpoint using API key authentication. No Google Cloud project or service account setup required.",
  register(api) {
    api.registerProvider(buildGoogleVertexExpressProvider());
  },
});
