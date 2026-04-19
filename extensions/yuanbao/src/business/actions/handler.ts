/**
 * Action handler.
 *
 * Calls createMessageSender directly to send messages, bypassing pipeline middlewares.
 * params already provide explicit send info (action, message, to, mediaUrl, stickerId, etc.),
 * no need for pipeline's layered transformations.
 *
 * Core design:
 * - resolveOutboundItems(): adapter, converts ActionParams to OutboundItem[]
 * - sender.send(item): existing type-dispatch strategy, handles all message types uniformly
 * - handler itself only orchestrates, does not dispatch
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

/** handleAction return type */
export interface ActionHandlerResult {
  channel: "yuanbao";
  ok: boolean;
  messageId: string;
  error?: Error;
  data?: unknown;
}

/**
 * Convert ActionParams to OutboundItem list.
 *
 * This is the only place that needs to understand params structure;
 * after conversion, subsequent flow is entirely handled by sender.send() type dispatch.
 */
function resolveOutboundItems(input: ActionParams): OutboundItem[] {
  const { params } = input;
  const action = params?.action ?? ((input as Record<string, unknown>).action as string) ?? "send";
  const items: OutboundItem[] = [];

  switch (action) {
    case "send": {
      // Extract text: params.message first, fallback to top-level text
      const text = params?.message ?? input.text ?? "";
      if (typeof text === "string" && text.trim()) {
        items.push({ type: "text", text });
      }

      // Collect all media URLs
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
      // Extract sticker ID (compat string | string[])
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

    // sticker-search does not produce OutboundItem, handled by handler short-circuit
    default:
      break;
  }

  return items;
}

/**
 * Handle Action request.
 *
 * Execution flow:
 * 1. sticker-search short-circuit → pure query, return directly
 * 2. resolveOutboundItems() → convert params to OutboundItem[]
 * 3. Create sender → sender.send(item) for each item
 */
export async function handleAction(input: ActionParams): Promise<ActionHandlerResult> {
  const log = createLog("actions");

  try {
    const { cfg, params } = input;
    const action =
      params?.action ?? ((input as Record<string, unknown>).action as string) ?? "send";
    const accountId = input.accountId;

    log.info("send info", { action, to: params?.to || params?.target });

    // sticker-search is a pure query, no need to create sender
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
      throw new Error("[handleAction] Yuanbao runtime not initialized");
    }
    const wsClient = getActiveWsClient(account.accountId);
    if (!wsClient) {
      throw new Error(`[handleAction] Account ${account.accountId} WsClient not ready`);
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

    // Send items sequentially, collect last successful messageId
    let lastMessageId = "";
    for (const item of items) {
      log.info("send for", { type: item.type });

      const result = await sender.send(item);
      if (!result.ok) {
        // Text send failure returns directly, media failure continues to send subsequent items
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
