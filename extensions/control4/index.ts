import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { buildControl4Prompt } from "./src/prompt.js";
import { createFindTool, createCommandTool, createStatusTool } from "./src/tools.js";

export default definePluginEntry({
  id: "control4",
  name: "Control4",
  description: "Control4 home automation — natural language control via WhatsApp.",
  register(api: OpenClawPluginApi) {
    api.registerTool(() => createFindTool(), { name: "control4_find" });
    api.registerTool(() => createCommandTool(), { name: "control4_command" });
    api.registerTool(() => createStatusTool(), { name: "control4_status" });

    api.on("before_prompt_build", async () => ({
      prependSystemContext: await buildControl4Prompt(),
    }));
  },
});
