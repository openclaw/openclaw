// Keep native echo registration on a narrow full-runtime entry so lightweight
// channel discovery does not load the Telegram bot runtime.
export { registerTelegramEchoRenderer } from "./src/echo-renderer-register.js";
