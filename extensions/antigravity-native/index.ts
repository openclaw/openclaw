import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAntigravityAccountHarness } from "./src/account-harness.js";
import type { AgySessionBinding } from "./src/bound-turn.js";

export default definePluginEntry({
  id: "antigravity-native",
  name: "Google Antigravity",
  description: "Runs explicitly selected turns through the Google Antigravity CLI.",
  register(api) {
    if (!["full", "discovery", "tool-discovery"].includes(api.registrationMode)) {
      return;
    }
    api.registerAgentHarness(
      createAntigravityAccountHarness((assertCurrent) =>
        api.runtime.state.openKeyedStoreV2<AgySessionBinding>(
          { namespace: "native-sessions", maxEntries: 10_000 },
          assertCurrent ? { assertCurrent } : undefined,
        ),
      ),
    );
  },
});
