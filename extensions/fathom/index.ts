import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createFathomCreateWebhookTool } from "./src/fathom-create-webhook-tool.js";
import { createFathomDeleteWebhookTool } from "./src/fathom-delete-webhook-tool.js";
import { createFathomGetSummaryTool } from "./src/fathom-get-summary-tool.js";
import { createFathomGetTranscriptTool } from "./src/fathom-get-transcript-tool.js";
import { createFathomListMeetingsTool } from "./src/fathom-list-meetings-tool.js";
import { createFathomListTeamMembersTool } from "./src/fathom-list-team-members-tool.js";
import { createFathomListTeamsTool } from "./src/fathom-list-teams-tool.js";

export default definePluginEntry({
  id: "fathom",
  name: "Fathom Plugin",
  description: "Bundled Fathom meetings, transcript, summary, and webhook tools",
  register(api) {
    api.registerTool(createFathomListMeetingsTool(api) as AnyAgentTool);
    api.registerTool(createFathomGetSummaryTool(api) as AnyAgentTool);
    api.registerTool(createFathomGetTranscriptTool(api) as AnyAgentTool);
    api.registerTool(createFathomListTeamsTool(api) as AnyAgentTool);
    api.registerTool(createFathomListTeamMembersTool(api) as AnyAgentTool);
    api.registerTool(createFathomCreateWebhookTool(api) as AnyAgentTool);
    api.registerTool(createFathomDeleteWebhookTool(api) as AnyAgentTool);
  },
});
