import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "a2a-broker-adapter",
  name: "A2A Broker Adapter",
  description: "Config-only opt-in surface for standalone A2A broker routing",
  register(_api: OpenClawPluginApi) {
    // sessions_send reads this plugin config as the standalone broker opt-in seam.
  },
});
