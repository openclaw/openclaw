// Whatsapp plugin entrypoint registers its OpenClaw integration.
import {
  type AnyAgentTool,
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

function createWhatsAppCallTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool | null {
  const createTool = loadBundledEntryExportSync<
    (api: OpenClawPluginApi, context: OpenClawPluginToolContext) => AnyAgentTool | null
  >(import.meta.url, {
    specifier: "./call-tool-api.js",
    exportName: "createWhatsAppCallTool",
  });
  return createTool(api, context);
}

export default defineBundledChannelEntry({
  id: "whatsapp",
  name: "WhatsApp",
  description: "WhatsApp channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "whatsappPlugin",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setWhatsAppRuntime",
  },
  registerFull(api) {
    api.registerTool((context) => createWhatsAppCallTool(api, context), {
      name: "whatsapp_call",
    });
  },
});
