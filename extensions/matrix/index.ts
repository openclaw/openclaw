import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { matrixPlugin } from "./src/channel.js";
import { setMatrixRuntime } from "./src/runtime.js";

export { matrixPlugin } from "./src/channel.js";
export { setMatrixRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin",
  plugin: matrixPlugin,
  setRuntime: setMatrixRuntime,
});
