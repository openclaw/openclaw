import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "payment",
  name: "Payment Plugin",
  description: "Bundled payment plugin: Stripe Link CLI + mock providers (V1 scaffold)",
  register(_api) {
    // Tool, CLI, and hook registration land in the feature plan units U5/U6.
    // This scaffold exists to verify boundary lints, build, and plugin loading.
  },
});
