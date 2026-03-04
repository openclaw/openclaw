import { randomUUID } from "node:crypto";
import { callDingtalkApi } from "./client.js";
import type { ResolvedDingtalkAccount } from "./types.js";

/**
 * 构建互动卡片数据（内嵌 Markdown） / Build interactive card data with embedded Markdown
 *
 * 使用钉钉互动卡片普通版，内容块为 Markdown 文本。
 * Uses DingTalk interactive card (standard version), content block is Markdown text.
 */
function buildCardData(content: string): Record<string, unknown> {
  return {
    config: {
      autoLayout: true,
      enableForward: true,
    },
    header: {
      title: {
        type: "text",
        text: "AI Assistant",
      },
      logo: "@lADPDfJ6v_hAS83NArzNArw",
    },
    contents: [
      {
        type: "markdown",
        text: content || "...",
        id: "markdown_content",
      },
    ],
  };
}

/**
 * 发送互动卡片（首次） / Send interactive card (initial)
 *
 * POST /v1.0/im/interactiveCards/send
 */
export async function sendDingtalkCard(params: {
  account: ResolvedDingtalkAccount;
  conversationType: "1" | "2";
  conversationId: string;
  senderStaffId: string;
  content: string;
}): Promise<{ cardBizId: string }> {
  const { account, conversationType, conversationId, senderStaffId, content } = params;
  const cardBizId = randomUUID();
  const robotCode = account.robotCode ?? account.clientId;
  if (!robotCode) {
    throw new Error(`DingTalk robotCode not configured for account "${account.accountId}"`);
  }

  const cardData = buildCardData(content);
  const body: Record<string, unknown> = {
    cardTemplateId: "StandardCard",
    outTrackId: cardBizId,
    cardData: {
      cardParamMap: cardData,
    },
    robotCode,
    callbackType: "STREAM",
  };

  // 群聊或单聊接收者 / Group or DM receiver
  if (conversationType === "2") {
    body.openConversationId = conversationId;
  } else {
    body.singleChatReceiver = JSON.stringify({
      senderRobotCode: robotCode,
      userId: senderStaffId,
    });
  }

  await callDingtalkApi({
    account,
    method: "POST",
    path: "/v1.0/im/interactiveCards/send",
    data: body,
  });

  return { cardBizId };
}

/**
 * 更新互动卡片内容（全量替换） / Update interactive card content (full replacement)
 *
 * PUT /v1.0/im/interactiveCards
 */
export async function updateDingtalkCard(params: {
  account: ResolvedDingtalkAccount;
  cardBizId: string;
  content: string;
}): Promise<void> {
  const { account, cardBizId, content } = params;

  const cardData = buildCardData(content);

  await callDingtalkApi({
    account,
    method: "PUT",
    path: "/v1.0/im/interactiveCards",
    data: {
      outTrackId: cardBizId,
      cardData: {
        cardParamMap: cardData,
      },
    },
  });
}

/**
 * 流式卡片会话 / Streaming card session
 *
 * 封装发送和更新卡片的流式输出逻辑。
 * Encapsulates the streaming output logic for sending and updating cards.
 */
export class DingtalkStreamingSession {
  private cardBizId: string | null = null;
  private account: ResolvedDingtalkAccount;
  private conversationType: "1" | "2";
  private conversationId: string;
  private senderStaffId: string;
  private log: (...args: unknown[]) => void;

  constructor(params: {
    account: ResolvedDingtalkAccount;
    conversationType: "1" | "2";
    conversationId: string;
    senderStaffId: string;
    log?: (...args: unknown[]) => void;
  }) {
    this.account = params.account;
    this.conversationType = params.conversationType;
    this.conversationId = params.conversationId;
    this.senderStaffId = params.senderStaffId;
    this.log = params.log ?? console.log;
  }

  // 开始流式输出（发送初始空卡片） / Start streaming (send initial empty card)
  async start(): Promise<void> {
    const result = await sendDingtalkCard({
      account: this.account,
      conversationType: this.conversationType,
      conversationId: this.conversationId,
      senderStaffId: this.senderStaffId,
      content: "...",
    });
    this.cardBizId = result.cardBizId;
  }

  // 更新流式内容 / Update streaming content
  async update(content: string): Promise<void> {
    if (!this.cardBizId) return;
    try {
      await updateDingtalkCard({
        account: this.account,
        cardBizId: this.cardBizId,
        content,
      });
    } catch (err) {
      this.log(`dingtalk: streaming card update failed: ${err}`);
    }
  }

  // 结束流式输出（发送最终内容） / Close streaming (send final content)
  async close(finalContent: string): Promise<void> {
    if (!this.cardBizId) return;
    try {
      await updateDingtalkCard({
        account: this.account,
        cardBizId: this.cardBizId,
        content: finalContent,
      });
    } catch (err) {
      this.log(`dingtalk: streaming card final update failed: ${err}`);
    }
    this.cardBizId = null;
  }

  isActive(): boolean {
    return this.cardBizId !== null;
  }
}
