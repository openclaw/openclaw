import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setNostrRuntime, getRuntime: getNostrRuntime } = createPluginRuntimeStore("Nostr runtime not initialized");
export {
  getNostrRuntime,
  setNostrRuntime
};
