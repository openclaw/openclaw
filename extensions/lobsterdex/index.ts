import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "lobsterdex",
  name: "Lobsterdex",
  description: "Browser-local lobster visitors and discoveries.",
  register(api) {
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "collection",
      label: "Lobsterdex",
      placement: "route:lobsterdex",
      icon: "lobster",
      requiredScopes: ["operator.sessions.read"],
    });
  },
});
