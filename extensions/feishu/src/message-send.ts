import { randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import { requestFeishuApi } from "./comment-shared.js";
import { withFeishuMessageDispatch } from "./send-context.js";

const INTERNAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveReplyMessageId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || INTERNAL_UUID_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

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
  const replyToMessageId = resolveReplyMessageId(params.replyToMessageId);
  return requestFeishuApi(
    () =>
      withFeishuMessageDispatch(() =>
        replyToMessageId
          ? target.client.im.message.reply({
              path: { message_id: replyToMessageId },
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
