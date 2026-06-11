// Telegram plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";

function registerTelegramFull(api: OpenClawPluginApi): void {
  if (api.registrationMode !== "full") {
    return;
  }
  const registerEchoRenderer = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(
    import.meta.url,
    {
      specifier: "./echo-renderer-api.js",
      exportName: "registerTelegramEchoRenderer",
    },
  );
  registerEchoRenderer(api);
}

export default defineBundledChannelEntry({
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "telegramPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setTelegramRuntime",
  },
  accountInspect: {
    specifier: "./account-inspect-api.js",
    exportName: "inspectTelegramReadOnlyAccount",
  },
  registerFull: registerTelegramFull,
});
