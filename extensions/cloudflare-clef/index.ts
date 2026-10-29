import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDecisionProvider } from "./provider.js";

export default definePluginEntry({
  id: "cloudflare-clef",
  name: "Cloudflare Clef",
  description: "Typed text and image decisions through the authenticated Cloudflare CLI.",
  register(api) {
    api.registerDecisionProvider(createDecisionProvider());
  },
});
