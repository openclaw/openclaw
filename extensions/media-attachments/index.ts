import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "media-attachments",
  name: "Media Attachments",
  description: "Prepare and normalize local media attachments.",
  register() {
    // Image operations are exposed through image-ops.ts so attachment hot paths
    // can load only the narrow public artifact instead of the full plugin entry.
  },
});
