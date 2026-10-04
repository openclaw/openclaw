// Line plugin entrypoint registers its OpenClaw integration.
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "line",
  name: "LINE",
  description: "LINE Messaging API channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "linePlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setLineRuntime",
  },
  registerFull(api) {
    api.registerCommand({
      name: "card",
      description: "Send a rich card message.",
      channels: ["line"],
      acceptsArgs: true,
      requireAuth: false,
      async handler(ctx) {
        const { handleLineCardCommand } = await import("./src/card-command.js");
        return await handleLineCardCommand(ctx.args);
      },
    });
  },
});
