import { feishuGroupNameCache } from "./bot-group-name-state.js";
import { getChatInfo } from "./chat.js";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

export async function resolveGroupName(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  log: (...args: unknown[]) => void;
}): Promise<string | undefined> {
  const { account, chatId, log } = params;
  if (!account.configured) {
    return undefined;
  }

  const { value } = await feishuGroupNameCache.read(
    `${account.accountId}:${chatId}`,
    async () => {
      try {
        const chatInfo = await getChatInfo(createFeishuClient(account), chatId);
        return chatInfo.name?.trim() || undefined;
      } catch (err) {
        log(`feishu[${account.accountId}]: getChatInfo failed for ${chatId}: ${String(err)}`);
        return undefined;
      }
    },
    { allowStale: false },
  );
  return value;
}
