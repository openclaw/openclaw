import type { ZulipApiSuccess, ZulipAuth } from "./client.js";
import { zulipRequest } from "./client.js";

export type ZulipSendMessageResponse = ZulipApiSuccess & {
  id?: number;
};

export async function sendZulipStreamMessage(params: {
  auth: ZulipAuth;
  stream: string;
  topic: string;
  content: string;
  abortSignal?: AbortSignal;
}): Promise<ZulipSendMessageResponse> {
  return await zulipRequest<ZulipSendMessageResponse>({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/messages",
    form: {
      type: "stream",
      to: params.stream,
      topic: params.topic,
      content: params.content,
    },
    abortSignal: params.abortSignal,
  });
}
