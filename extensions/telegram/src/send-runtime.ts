import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Telegram plugin module owns the lazy send runtime import.
export const loadTelegramSendModule = createLazyRuntimeModule(() => import("./send.js"));
