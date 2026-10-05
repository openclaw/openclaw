import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { registerXAllowlistMethods } from "./admin-api.js";

export default defineBundledChannelEntry({
  id: "x",
  name: "X (Twitter)",
  description: "Allowlisted X mentions and public replies",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin-api.js", exportName: "xPlugin" },
  secrets: { specifier: "./secret-contract-api.js", exportName: "channelSecrets" },
  runtime: { specifier: "./runtime-api.js", exportName: "setXRuntime" },
  registerFull(api) {
    loadBundledEntryExportSync<typeof registerXAllowlistMethods>(import.meta.url, {
      specifier: "./admin-api.js",
      exportName: "registerXAllowlistMethods",
    })(api);
  },
});
