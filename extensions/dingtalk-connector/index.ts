import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

/**
 * Lazily-loaded gateway-method registrar. Mirrors the Feishu pattern of
 * letting `defineBundledChannelEntry` handle base channel registration on
 * the hot path while deferring "extras" until the host requests the full
 * registration mode.
 */
function registerDingtalkGatewayMethods(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(
    import.meta.url,
    {
      specifier: "./api.js",
      exportName: "registerDingtalkGatewayMethods",
    },
  );
  register(api);
}

export default defineBundledChannelEntry({
  id: "dingtalk-connector",
  name: "DingTalk",
  description:
    "DingTalk (钉钉) channel — Stream mode connector with AI Card streaming, multi-account support, and DM/group security policies.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "dingtalkPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setDingtalkRuntime",
  },
  registerFull(api) {
    registerDingtalkGatewayMethods(api);
  },
});
