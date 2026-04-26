import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCreelContextPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "creel-context",
  name: "Creel Context",
  description:
    "Classifies inbound senders against the Creel control plane and threads the resulting envelope through the prompt and chat-history scope filter.",
  register: registerCreelContextPlugin,
});
