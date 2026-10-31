import { randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import { requestFeishuApi } from "./comment-shared.js";
import { withFeishuMessageDispatch } from "./send-context.js";

export function sendFeishuMessage(
  target: {
    client: Client;
    receiveId: string;
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  },
  params: {
    content: string;
    msgType: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
    rootId?: string;
  },
  errorPrefix: string,
) {
  // Feishu deduplicates create/reply by UUID for one hour, including lost responses.
  const data = { content: params.content, msg_type: params.msgType, uuid: randomUUID() };
  return requestFeishuApi(
    () =>
      withFeishuMessageDispatch(() =>
        params.replyToMessageId
          ? target.client.im.message.reply({
              path: { message_id: params.replyToMessageId },
              data: { ...data, ...(params.replyInThread ? { reply_in_thread: true } : {}) },
            })
          : target.client.im.message.create({
              params: { receive_id_type: target.receiveIdType },
              data: {
                ...data,
                receive_id: target.receiveId,
                // Feishu accepts root_id although the SDK omits it from create's type.
                ...(params.rootId ? { root_id: params.rootId } : {}),
              },
            }),
      ),
    errorPrefix,
    { includeNestedErrorLogId: true, retryTransient: true },
  );
}
