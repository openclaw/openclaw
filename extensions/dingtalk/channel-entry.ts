import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

/**
 * Slim channel entry alternative: same id as `index.ts` but without the
 * `registerFull` extras. Useful for hosts that only want the bare channel
 * registered without the gateway-methods surface.
 */
export default defineBundledChannelEntry({
  id: "dingtalk",
  name: "DingTalk",
  description: "DingTalk (钉钉) channel — Stream mode connector with AI Card streaming.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "dingtalkPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setDingtalkRuntime",
  },
});
