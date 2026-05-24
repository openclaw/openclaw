import { createEvenniaCommandTool, evenniaPlugin, evenniaStagingPlugin } from "./src/channel.js";

export default {
  id: "evennia",
  name: "Evennia",
  description: "OpenClaw channel bridge for Evennia MUD characters.",
  channelPlugin: evenniaPlugin,
  register(api) {
    if (api.registrationMode === "cli-metadata") {
      return;
    }
    if (api.registrationMode === "tool-discovery") {
      api.registerTool(createEvenniaCommandTool(), { name: "evennia_command" });
      return;
    }
    api.registerChannel({ plugin: evenniaPlugin });
    api.registerChannel({ plugin: evenniaStagingPlugin });
    if (api.registrationMode === "full") {
      api.registerTool(createEvenniaCommandTool(), { name: "evennia_command" });
    }
  },
};
