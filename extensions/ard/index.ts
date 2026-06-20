// ARD plugin entrypoint keeps discovery primitives plugin-owned.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "ard",
  name: "Agent Resource Discovery",
  description: "Bundled Agent Resource Discovery catalog plugin",
  register() {
    // Metadata-only today. Future catalog ingestion/search hooks belong here.
  },
});
