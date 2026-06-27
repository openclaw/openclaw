// Keep bundled registration fast: the runtime setter is needed during plugin
// bootstrap, but the broad runtime-api barrel pulls in WhatsApp runtime modules.
export { setWhatsAppRuntime } from "./src/runtime.js";
export {
  getWhatsAppMonitorRuntimeOptions,
  setWhatsAppMonitorRuntimeOptions,
  type WhatsAppCreateSocket,
  type WhatsAppMonitorRuntimeOptions,
  type WhatsAppSocket,
} from "./src/monitor-runtime-options.js";
