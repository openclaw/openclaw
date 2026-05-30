import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "webhooks",
  name: "Webhooks",
  description: "Authenticated inbound webhooks for OpenClaw.",
  register(api) {
    api.registerCli(() => {}, {
      parentPath: ["webhooks"],
      descriptors: [
        {
          name: "subscribe",
          description: "Create or update a Gateway-managed webhook subscription",
          hasSubcommands: false,
        },
        {
          name: "list",
          description: "List Gateway-managed webhook subscriptions",
          hasSubcommands: false,
        },
        {
          name: "remove",
          description: "Remove a Gateway-managed webhook subscription",
          hasSubcommands: false,
        },
        {
          name: "test",
          description: "Send a signed test delivery to a webhook subscription",
          hasSubcommands: false,
        },
      ],
    });
  },
});
