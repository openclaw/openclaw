import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTinyFishTool } from "./src/tinyfish-tool.js";

export default definePluginEntry({
  id: "tinyfish",
  name: "TinyFish",
  description: "Hosted browser automation for complex public web workflows.",
  register(api) {
    api.registerTool(createTinyFishTool(api));
  },
});
