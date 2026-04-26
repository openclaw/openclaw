import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerComputerPlugin } from "./plugin-registration.js";

export default definePluginEntry({
  id: "computer",
  name: "Computer",
  description: "macOS desktop automation via cua-driver (MIT licensed)",
  register: registerComputerPlugin,
});
