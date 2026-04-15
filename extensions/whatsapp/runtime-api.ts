// Keep the public WhatsApp runtime sidecar narrow.
// Heavy Baileys-backed runtime surfaces should stay behind lighter wrappers so
// the root dist does not eagerly mirror plugin-private runtime deps.
export * from "./src/runtime-api.js";
export { setWhatsAppRuntime } from "./src/runtime.js";
export { startWebLoginWithQr, waitForWebLogin } from "./login-qr-runtime.js";
