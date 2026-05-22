// Narrow entry point for setWhatsAppRuntime. The full runtime-api barrel pulls
// in Baileys/media/session runtime and is too expensive for plugin register().
export { setWhatsAppRuntime } from "./src/runtime.js";
