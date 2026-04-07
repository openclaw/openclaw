import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeGoogleProviderConfig } from "./api.js";

export default definePluginEntry({
  id: "google",
  name: "Google Setup",
  description: "Lightweight Google setup hooks",
  register(api) {
    api.registerProvider({
      id: "google",
      label: "Google AI Studio",
      hookAliases: ["google-antigravity", "google-vertex"],
      auth: [],
      normalizeConfig: ({ provider, providerConfig }) =>
        normalizeGoogleProviderConfig(provider, providerConfig),
    });
  },
});
