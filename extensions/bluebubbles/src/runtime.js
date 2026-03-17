import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const runtimeStore = createPluginRuntimeStore("BlueBubbles runtime not initialized");
const setBlueBubblesRuntime = runtimeStore.setRuntime;
function clearBlueBubblesRuntime() {
  runtimeStore.clearRuntime();
}
function tryGetBlueBubblesRuntime() {
  return runtimeStore.tryGetRuntime();
}
function getBlueBubblesRuntime() {
  return runtimeStore.getRuntime();
}
function warnBlueBubbles(message) {
  const formatted = `[bluebubbles] ${message}`;
  const log = runtimeStore.tryGetRuntime()?.log;
  if (typeof log === "function") {
    log(formatted);
    return;
  }
  console.warn(formatted);
}
export {
  clearBlueBubblesRuntime,
  getBlueBubblesRuntime,
  setBlueBubblesRuntime,
  tryGetBlueBubblesRuntime,
  warnBlueBubbles
};
