import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "dingtalk-connector",
  name: "DingTalk",
  description:
    "DingTalk (钉钉) channel — Stream mode connector with multi-account support and DM/group security policies.",
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
