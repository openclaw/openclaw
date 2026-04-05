import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { linePlugin } from "./src/channel.js";
import { setLineRuntime } from "./src/runtime.js";

export { linePlugin } from "./src/channel.js";
export { setLineRuntime } from "./src/runtime.js";

type RegisteredLineCardCommand = Parameters<OpenClawPluginApi["registerCommand"]>[0];

let lineCardCommandPromise: Promise<RegisteredLineCardCommand> | null = null;

async function loadLineCardCommand(api: OpenClawPluginApi): Promise<RegisteredLineCardCommand> {
  lineCardCommandPromise ??= (async () => {
    let registered: RegisteredLineCardCommand | null = null;
    const { registerLineCardCommand } = await import("./src/card-command.js");
    registerLineCardCommand({
      ...api,
      registerCommand(command: RegisteredLineCardCommand) {
        registered = command;
      },
    });
    if (!registered) {
      throw new Error("LINE card command registration unavailable");
    }
    return registered;
  })();
  return await lineCardCommandPromise;
}

export default defineChannelPluginEntry({
  id: "line",
  name: "LINE",
  description: "LINE Messaging API channel plugin",
  plugin: linePlugin,
  setRuntime: setLineRuntime,
  registerFull(api) {
    api.registerCommand({
      name: "card",
      description: "Send a rich card message (LINE).",
      acceptsArgs: true,
      requireAuth: false,
      async handler(ctx) {
        const command = await loadLineCardCommand(api);
        return await command.handler(ctx);
      },
    });
  },
});
