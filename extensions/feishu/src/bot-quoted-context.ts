import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuMediaList } from "./bot-content.js";
import { shouldIncludeFetchedGroupContextMessage } from "./policy.js";
import { getMessageFeishu } from "./send.js";
import type { FeishuMediaInfo, FeishuMessageInfo } from "./types.js";

type FetchedContextPolicy = Omit<
  Parameters<typeof shouldIncludeFetchedGroupContextMessage>[0],
  "kind" | "senderId" | "senderType"
>;

export async function resolveFeishuQuotedContext(params: {
  cfg: ClawdbotConfig;
  parentId?: string;
  rootId?: string;
  getRootMessageInfo: () => Promise<FeishuMessageInfo | null>;
  fetchedContextPolicy: FetchedContextPolicy;
  mediaMaxBytes: number;
  log: (message: string) => void;
  accountId: string;
}): Promise<{ content?: string; media: FeishuMediaInfo[] }> {
  if (!params.parentId) {
    return { media: [] };
  }
  try {
    const message =
      params.parentId === params.rootId
        ? await params.getRootMessageInfo()
        : await getMessageFeishu({
            cfg: params.cfg,
            messageId: params.parentId,
            accountId: params.accountId,
          });
    if (
      !message ||
      !(await shouldIncludeFetchedGroupContextMessage({
        ...params.fetchedContextPolicy,
        kind: "quote",
        senderId: message.senderId,
        senderType: message.senderType,
      }))
    ) {
      if (message) {
        params.log(
          `feishu[${params.accountId}]: skipped quoted message from sender ${message.senderId ?? "unknown"} (mode=${params.fetchedContextPolicy.mode})`,
        );
      }
      return { media: [] };
    }
    return {
      content: message.content,
      media: await resolveFeishuMediaList({
        cfg: params.cfg,
        messageId: message.messageId,
        messageType: message.contentType,
        content: message.rawContent ?? "",
        maxBytes: params.mediaMaxBytes,
        log: params.log,
        accountId: params.accountId,
      }),
    };
  } catch (err) {
    params.log(`feishu[${params.accountId}]: failed to fetch quoted message: ${String(err)}`);
    return { media: [] };
  }
}
