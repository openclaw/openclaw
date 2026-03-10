/**
 * CardKit API - 飞书卡片实体操作
 * 
 * 用于实现流式输出的卡片创建和更新
 * 参考：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/create
 */

import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";

/**
 * 卡片实体数据（Schema 2.0）
 */
export type CardEntityData = {
  schema: "2.0";
  config?: {
    update_multi?: boolean;
    wide_screen_mode?: boolean;
    streaming_mode?: boolean;
  };
  header?: {
    title?: {
      tag: "plain_text" | "emoji";
      content: string;
      emoji_type?: string;
    };
    template?: string;
  };
  body: {
    elements: Array<{
      tag: string;
      content?: string;
      text?: {
        tag?: string;
        content?: string;
      };
      [key: string]: unknown;
    }>;
  };
};

/**
 * 创建卡片实体
 * 
 * @returns card_id 用于后续更新
 */
export async function createCardEntity(params: {
  cfg: ClawdbotConfig;
  content: string;
  title?: string;
  accountId?: string;
}): Promise<string | null> {
  const { cfg, content, title = "AI 助手", accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  // CardKit 2.0 schema
  const cardData: CardEntityData = {
    schema: "2.0",
    config: {
      update_multi: true, // 共享卡片，所有人可见更新
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: content,
        },
      ],
    },
  };

  try {
    // 使用 cardkit.v1.card.create API
    const response = await client.cardkit.v1.card.create({
      request_body: {
        type: "card_json",
        data: JSON.stringify(cardData),
      },
    });

    if (response.code === 0 && response.data?.card_id) {
      return response.data.card_id;
    }

    console.error(`feishu: create card entity failed: ${response.msg || `code ${response.code}`}`);
    return null;
  } catch (err) {
    console.error(`feishu: create card entity error: ${String(err)}`);
    return null;
  }
}

/**
 * 更新卡片实体内容
 * 
 * ⚠️ sequence 必须严格递增，否则更新会失败
 * 
 * @param card_id 卡片 ID
 * @param content 新的 Markdown 内容
 * @param sequence 序列号（从 1 开始，每次 +1）
 */
export async function updateCardEntity(params: {
  cfg: ClawdbotConfig;
  cardId: string;
  content: string;
  sequence: number;
  accountId?: string;
}): Promise<boolean> {
  const { cfg, cardId, content, sequence, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const cardData: CardEntityData = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: content,
        },
      ],
    },
  };

  try {
    // 使用 cardkit.v1.card.update API
    const response = await client.cardkit.v1.card.update({
      path: { card_id: cardId },
      request_body: {
        card: {
          type: "card_json",
          data: JSON.stringify(cardData),
        },
        sequence: sequence, // ⚠️ 必须严格递增
      },
    });

    if (response.code === 0) {
      return true;
    }

    console.error(
      `feishu: update card entity failed (card_id=${cardId}, seq=${sequence}): ${response.msg || `code ${response.code}`}`,
    );
    return false;
  } catch (err) {
    console.error(
      `feishu: update card entity error (card_id=${cardId}, seq=${sequence}): ${String(err)}`,
    );
    return false;
  }
}

/**
 * 构建卡片数据（Schema 2.0）
 */
export function buildCardData(params: {
  content: string;
  title?: string;
  streaming?: boolean;
}): CardEntityData {
  const { content, title, streaming } = params;

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
      ...(streaming ? { streaming_mode: true } : {}),
    },
    header: title
      ? {
          title: {
            tag: "plain_text",
            content: title,
          },
        }
      : undefined,
    body: {
      elements: [
        {
          tag: "markdown",
          content: content,
        },
      ],
    },
  };
}
