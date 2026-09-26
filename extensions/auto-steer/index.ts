import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { classifyInputRoute } from "./src/classify.js";

export default definePluginEntry({
  id: "auto-steer",
  name: "Auto steering",
  description: "Advise whether an opted-in chat message refines the active task or follows it.",
  register(api) {
    api.on("input_route", (event, context) =>
      classifyInputRoute(api.runtime.decisions, event, context),
    );
  },
});
