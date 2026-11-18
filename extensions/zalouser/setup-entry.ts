import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerZalouserRuntimeLifecycle } from "./src/session-runtime.js";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "zalouserSetupPlugin",
  },
  registerSetupRuntime: registerZalouserRuntimeLifecycle,
});
