import type { OpenClawPluginApi } from "openclaw/plugin-sdk/compat";
import { createTinyFishTool } from "./src/tinyfish-tool.js";

const plugin = {
  id: "tinyfish",
  name: "TinyFish",
  description: "Hosted browser automation for complex public web workflows.",
  register(api: OpenClawPluginApi) {
    api.registerTool(createTinyFishTool(api));
  },
};

export default plugin;
