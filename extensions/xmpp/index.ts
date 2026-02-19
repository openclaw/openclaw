import { defineExtension } from "openclaw/plugin-sdk";
import { XmppChannel } from "./src/channel.js";
import { XmppConfigSchema } from "./src/config-schema.js";

export default defineExtension({
  configSchema: XmppConfigSchema,
  channel: {
    construct: (ctx) => new XmppChannel(ctx),
  },
});
