import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { buildAnthropicInteractiveCliBackend } from "./cli-backend-interactive.js";

export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic Setup",
  description: "Lightweight Anthropic setup hooks",
  register(api) {
    api.registerCliBackend(buildAnthropicCliBackend());
    // Setup lookup narrows by manifest owner then matches a backend id from
    // the setup-registered list. The manifest declares claude-cli-interactive,
    // so the setup entry must register it too — cold setup/live-test/fallback
    // paths cannot resolve this backend before the full runtime registry is
    // active otherwise.
    api.registerCliBackend(buildAnthropicInteractiveCliBackend());
  },
});
