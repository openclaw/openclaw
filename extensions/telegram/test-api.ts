// Telegram API module exposes the plugin public contract.
export { testing as telegramPollingSessionTesting } from "./src/polling-session.js";
export { sendMessageTelegram, sendPollTelegram, type TelegramApiOverride } from "./src/send.js";
export { resetTelegramThreadBindingsForTests } from "./src/thread-bindings.js";
