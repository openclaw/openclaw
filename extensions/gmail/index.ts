import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createGmailWatcherService } from "./src/watcher-service.js";

export default definePluginEntry({
  id: "gmail",
  name: "Gmail Pub/Sub",
  description: "Run and renew a Gog Gmail Pub/Sub watcher.",
  register(api) {
    if (api.registrationMode === "full") {
      api.registerService(createGmailWatcherService());
    }
  },
});
