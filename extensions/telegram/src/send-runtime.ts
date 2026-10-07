import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
export type TelegramSendModule = typeof import("./send.js");

export const loadTelegramSendModule = createLazyRuntimeModule(() => import("./send.js"));
