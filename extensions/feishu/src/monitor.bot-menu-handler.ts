import { isRecord, readStringValue as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, HistoryEntry, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { maybeHandleFeishuQuickActionMenu } from "./card-ux-launcher.js";
import { claimUnprocessedFeishuMessage, forgetProcessedFeishuMessage } from "./dedup.js";
import { botOpenIds } from "./monitor.state.js";
import { isFeishuRetryableSyntheticEventError } from "./monitor.synthetic-error.js";

export function createFeishuBotMenuHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
  isAccountActive?: () => boolean;
  trackTask?: (task: Promise<void>) => void;
  getBotOpenId?: (accountId: string) => string | undefined;
}): (data: unknown) => Promise<void> {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const getBotOpenId = params.getBotOpenId ?? ((id) => botOpenIds.get(id));

  const isActive = params.isAccountActive ?? (() => true);
  const handle = async (data: unknown) => {
    try {
      if (!isActive()) {
        return;
      }
      if (!isRecord(data) || !isRecord(data.operator) || !isRecord(data.operator.operator_id)) {
        return;
      }
      const operatorId = data.operator.operator_id;
      const operatorOpenId = readString(operatorId.open_id)?.trim();
      const eventKey = readString(data.event_key)?.trim();
      if (!operatorOpenId || !eventKey) {
        return;
      }
      const syntheticEvent: FeishuMessageEvent = {
        sender: {
          sender_id: {
            open_id: operatorOpenId,
            user_id: readString(operatorId.user_id),
            union_id: readString(operatorId.union_id),
          },
          sender_type: "user",
        },
        message: {
          message_id: `bot-menu:${eventKey}:${typeof data.timestamp === "string" || typeof data.timestamp === "number" ? data.timestamp : Date.now()}`,
          suppress_reply_target: true,
          chat_id: `p2p:${operatorOpenId}`,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: `/menu ${eventKey}`,
          }),
        },
      };
      const syntheticMessageId = syntheticEvent.message.message_id;
      const claim = await claimUnprocessedFeishuMessage({
        messageId: syntheticMessageId,
        namespace: accountId,
        log,
      });
      if (!isActive()) {
        if (claim.kind === "claimed") {
          claim.handle.release({ error: new Error("feishu account stopped before menu dispatch") });
        }
        return;
      }
      if (claim.kind === "duplicate") {
        log(`feishu[${accountId}]: dropping duplicate bot-menu event for ${syntheticMessageId}`);
        return;
      }
      if (claim.kind === "inflight") {
        log(`feishu[${accountId}]: dropping in-flight bot-menu event for ${syntheticMessageId}`);
        return;
      }
      const handleLegacyMenu = () =>
        handleFeishuMessage({
          trackTask: params.trackTask,
          cfg,
          event: syntheticEvent,
          botOpenId: getBotOpenId(accountId),
          runtime,
          channelRuntime: params.channelRuntime,
          chatHistories,
          accountId,
          processingClaim: claim.kind === "claimed" ? claim.handle : undefined,
        });

      const promise = maybeHandleFeishuQuickActionMenu({
        cfg,
        eventKey,
        operatorOpenId,
        runtime,
        accountId,
      })
        .then(async (handledMenu) => {
          if (handledMenu) {
            if (claim.kind === "claimed") {
              await claim.handle.commit();
            }
            return;
          }
          if (!isActive()) {
            if (claim.kind === "claimed") {
              claim.handle.release({
                error: new Error("feishu account stopped before menu dispatch"),
              });
            }
            return;
          }
          return handleLegacyMenu();
        })
        .catch(async (err: unknown) => {
          if (isFeishuRetryableSyntheticEventError(err)) {
            await forgetProcessedFeishuMessage(syntheticMessageId, accountId, log);
            if (claim.kind === "claimed") {
              claim.handle.release({ error: err });
            }
          } else if (claim.kind === "claimed") {
            await claim.handle.commit();
          }
          throw err;
        });
      params.trackTask?.(promise);
      if (fireAndForget) {
        promise.catch((err: unknown) => {
          error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
        });
        return;
      }
      await promise;
    } catch (err) {
      error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
    }
  };
  return (data) => {
    const task = handle(data);
    params.trackTask?.(task);
    return task;
  };
}
