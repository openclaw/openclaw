// Keep bundled channel bootstrap loads narrow so lightweight config-presence
// probes do not import the broad WhatsApp API barrel.
export { whatsappPlugin } from "./src/channel.js";
export { whatsappSetupPlugin } from "./src/channel.setup.js";
