import { AsyncLocalStorage } from "node:async_hooks";

export type TelegramPeerBotTurn = {
  accountId: string;
  chatAliases?: string[];
  chatId: string;
  messageId: number;
  senderAliases?: string[];
  senderId: string;
  threadId?: number;
};

const telegramPeerBotTurn = new AsyncLocalStorage<TelegramPeerBotTurn>();

export function runWithTelegramPeerBotTurn<T>(
  turn: TelegramPeerBotTurn,
  run: () => Promise<T>,
): Promise<T> {
  return telegramPeerBotTurn.run(turn, run);
}

export function getTelegramPeerBotTurn(): TelegramPeerBotTurn | undefined {
  return telegramPeerBotTurn.getStore();
}
