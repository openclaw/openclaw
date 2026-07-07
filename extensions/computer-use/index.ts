import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerComputerUsePlugin } from "./plugin-registration.js";

export default definePluginEntry({
  id: "computer-use",
  name: "Computer Use",
  description: "Control a paired macOS node through screenshots and single input actions.",
  register: registerComputerUsePlugin,
});
