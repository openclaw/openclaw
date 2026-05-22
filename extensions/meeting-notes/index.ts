import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { manualTranscriptSourceProvider } from "./src/manual-source.js";
import { createMeetingNotesAutoStartService, createMeetingNotesTool } from "./src/tool.js";

export default definePluginEntry({
  id: "meeting-notes",
  name: "Meeting Notes",
  description: "Capture and summarize meeting transcripts from generic source providers.",
  register(api) {
    api.registerMeetingNotesSourceProvider(manualTranscriptSourceProvider);
    api.registerTool(createMeetingNotesTool(api), { name: "meeting_notes" });
    api.registerService(createMeetingNotesAutoStartService(api));
  },
});
