export async function buildTelegramMessageContextForTest(
  ...args: Parameters<
    typeof import("./src/bot-message-context.test-harness.js").buildTelegramMessageContextForTest
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./src/bot-message-context.test-harness.js").buildTelegramMessageContextForTest
    >
  >
> {
  const { buildTelegramMessageContextForTest: buildForTest } =
    await import("./src/bot-message-context.test-harness.js");
  return await buildForTest(...args);
}
export { handleTelegramAction } from "./src/action-runtime.js";
export { telegramMessageActionRuntime } from "./src/channel-actions.js";
export { telegramPlugin } from "./src/channel.js";
export { listTelegramAccountIds, resolveTelegramAccount } from "./src/accounts.js";
export { resolveTelegramFetch } from "./src/fetch.js";
export { makeProxyFetch } from "./src/proxy.js";
export { telegramOutbound } from "./src/outbound-adapter.js";
export { setTelegramRuntime } from "./src/runtime.js";
export { sendMessageTelegram, sendPollTelegram, type TelegramApiOverride } from "./src/send.js";
