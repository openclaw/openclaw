/**
 * Action 处理器
 *
 * 直接调用 createMessageSender 发送消息，跳过 pipeline 中间件。
 * params 已经给出了明确的发送信息（action、message、to、mediaUrl、stickerId 等），
 * 不需要经过 pipeline 的层层转换。
 *
 * Core design:
 * - resolveOutboundItems()：适配器，将 ActionParams 转换为 OutboundItem[]
 * - sender.send(item)：已有的类型分发策略，统一处理所有Message type
 * - handler 本身只做编排，不做分发
 */

import { getActiveWsClient } from "../../access/ws/runtime.js";
import { resolveYuanbaoAccount } from "../../accounts.js";
import { createLog } from "../../logger.js";
import { getYuanbaoRuntime } from "../../runtime.js";
import { createMessageSender } from "../outbound/create-sender.js";
import type { OutboundItem } from "../outbound/types.js";
import type { ActionParams } from "./resolve-target.js";
import { resolveActionTarget } from "./resolve-target.js";
import { searchSticker } from "./sticker/send.js";

// ============ 类型定义 ============

/** handleAction 的返回值 */
export interface ActionHandlerResult {
  channel: "yuanbao";
  ok: boolean;
  messageId: string;
  error?: Error;
  data?: unknown;
}

// ============ 适配器：ActionParams → OutboundItem[] ============

/**
 * 将 ActionParams 转换为 OutboundItem 列表
 *
 * 这是唯一需要理解 params 结构的地方，
 * 转换完成后，后续流程完全由 sender.send() 的类型分发接管。
 *
 * @param input - 框架传入的原始参数
 * @returns 待发送的 OutboundItem 列表
 */
function resolveOutboundItems(input: ActionParams): OutboundItem[] {
  const { params } = input;
  const action = params?.action ?? ((input as Record<string, unknown>).action as string) ?? "send";
  const items: OutboundItem[] = [];

  switch (action) {
    case "send": {
      // Extract文本：params.message 优先，回退到顶层 text
      const text = params?.message ?? input.text ?? "";
      if (typeof text === "string" && text.trim()) {
        items.push({ type: "text", text });
      }

      // 收集所有Media URL
      const mediaUrl = params?.media ?? params?.mediaUrl ?? undefined;
      const mediaUrls = Array.isArray(params?.mediaUrls) ? params.mediaUrls : undefined;
      for (const url of mediaUrls ?? (mediaUrl ? [mediaUrl] : [])) {
        if (typeof url === "string" && url.trim()) {
          items.push({ type: "media", mediaUrl: url });
        }
      }
      break;
    }

    case "sticker":
    case "react": {
      // Extract sticker ID（兼容 string | string[]）
      const rawStickerId = params?.sticker_id ?? params?.stickerId;
      const stickerId = Array.isArray(rawStickerId)
        ? String(rawStickerId[0] ?? "")
        : typeof rawStickerId === "string"
          ? rawStickerId
          : "";
      if (stickerId) {
        items.push({ type: "sticker", stickerId });
      }
      break;
    }

    // sticker-search 不产生 OutboundItem，由 handler 短路处理
    default:
      break;
  }

  return items;
}

// ============ 核心处理器 ============

/**
 * 处理 Action 请求
 *
 * Execution flow:
 * 1. sticker-search 短路 → 纯查询，直接返回
 * 2. resolveOutboundItems() → 将 params 转换为 OutboundItem[]
 * 3. 创建 sender → sender.send(item) 逐个发送
 *
 * @param rawParams - 框架传入的原始参数
 * @returns 发送结果
 */
export async function handleAction(input: ActionParams): Promise<ActionHandlerResult> {
  const log = createLog("actions");

  try {
    const { cfg, params } = input;
    const action =
      params?.action ?? ((input as Record<string, unknown>).action as string) ?? "send";
    const accountId = input.accountId;

    log.info("send info", { action, to: params?.to || params?.target });

    // ⭐ sticker-search 是纯查询，不需要创建 sender
    if (action === "sticker-search") {
      const result = searchSticker((params ?? {}) as Record<string, unknown>);
      return {
        channel: "yuanbao",
        ok: result.ok,
        messageId: "",
        data: "data" in result ? result.data : undefined,
      };
    }

    const items = resolveOutboundItems(input);

    if (items.length === 0) {
      return {
        channel: "yuanbao",
        ok: false,
        messageId: "",
        error: new Error("no sendable items resolved from params"),
      };
    }

    const account = resolveYuanbaoAccount({ cfg, accountId });
    const core = getYuanbaoRuntime();
    if (!core) {
      throw new Error("[handleAction] Yuanbao runtime 未初始化");
    }
    const wsClient = getActiveWsClient(account.accountId);
    if (!wsClient) {
      throw new Error(`[handleAction] 账号 ${account.accountId} 的 WsClient 未就绪`);
    }

    const resolved = resolveActionTarget(input);

    const sender = createMessageSender({
      isGroup: resolved.isGroup,
      groupCode: resolved.groupCode,
      account,
      target: resolved.target,
      fromAccount: account.botId,
      wsClient,
      config: cfg,
      core,
    });

    // 逐个发送，收集最后一个成功的 messageId
    let lastMessageId = "";
    for (const item of items) {
      log.info("send for", { type: item.type });

      const result = await sender.send(item);
      if (!result.ok) {
        // 文本发送失败直接返回，Media失败继续发送后续项
        if (item.type === "text") {
          return {
            channel: "yuanbao",
            ok: false,
            messageId: result.messageId ?? "",
            error: new Error(result.error ?? "text send failed"),
          };
        }
        log.error(`${item.type} send failed: ${result.error}`);
      } else if (result.messageId) {
        lastMessageId = result.messageId;
      }
    }

    return { channel: "yuanbao", ok: true, messageId: lastMessageId };
  } catch (err) {
    log.error("handle action error", { error: err instanceof Error ? err.message : String(err) });
    return {
      channel: "yuanbao",
      ok: false,
      messageId: "",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
