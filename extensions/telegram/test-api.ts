export { telegramPlugin } from "./src/channel.js";
export { getOrCreateAccountThrottler, releaseAccountThrottler } from "./src/account-throttler.js";
export { apiThrottler } from "./src/bot.runtime.js";
export type { ReplyResolverOptions } from "./src/bot-message-dispatch.telegram-http.test-support.js";
// The Bot API dispatch fixture registers Vitest hooks, so host suites load it on demand.
export const loadTelegramDispatchHttpFixture = () =>
  import("./src/bot-message-dispatch.telegram-http.test-support.js");
// The send fixture registers lifecycle hooks; host suites load it only on demand.
export const loadTelegramSendHttpFixture = () => import("./src/send.telegram-http.test-support.js");
export { renderTelegramProgressDraftPreview } from "./src/progress-draft-preview.js";
export { telegramHtmlToPlainTextFallback } from "./src/format.js";
export { resolveTelegramMessageCacheScope } from "./src/message-cache-persistence.js";
export { createTelegramMessageCache } from "./src/message-cache.js";
export {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
  resetTelegramMessageCacheForTest,
} from "./src/runtime.test-support.js";
