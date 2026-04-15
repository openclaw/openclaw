/**
 * Message inbound processing module
 *
 * Unified entry point, single responsibility:
 * - 系统回调（Recall等）同步分发，不进入防抖
 * - 普通消息委托给 dispatcher/debouncer 进行防抖 + 会话级串行化
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import { ensureDebouncer } from "../../dispatcher/debouncer/index.js";
import "../messaging/callbacks/recall.js";
import { createLog } from "../../logger.js";
import type { ModuleLog } from "../../logger.js";
import type { YuanbaoInboundMessage, ResolvedYuanbaoAccount } from "../../types.js";
import { dispatchSystemCallback } from "../messaging/system-callbacks.js";

// ============ 统一入口 ============

export type InboundMessageParams = {
  msg: YuanbaoInboundMessage;
  isGroup: boolean;
  account: ResolvedYuanbaoAccount;
  config: OpenClawConfig;
  core: PluginRuntime;
  wsClient: YuanbaoWsClient;
  log?:
    | ModuleLog
    | {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
        verbose?: (msg: string) => void;
      };
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  abortSignal?: AbortSignal;
};

/**
 * Unified message processing entry
 *
 * System callbacks (recall, etc.) are dispatched synchronously, not debounced;
 * 普通消息委托给 dispatcher 层的 debouncer 进行防抖 + 会话级串行化。
 */
export async function handleInboundMessage(params: InboundMessageParams): Promise<void> {
  const { msg, isGroup, account, config, core, wsClient, log, statusSink, abortSignal } = params;

  // 系统回调（Recall等）：同步分发，不进入防抖队列
  const callbackLog = createLog("system-callback", log as ModuleLog | undefined);
  const callbackCtx = {
    account,
    config,
    core,
    log: {
      ...callbackLog,
      verbose: (...args: Parameters<typeof callbackLog.debug>) => callbackLog.debug(...args),
    },
    wsClient,
    abortSignal,
    statusSink,
  };
  if (dispatchSystemCallback({ ctx: callbackCtx, msg, isGroup })) {
    return;
  }

  // 委托给 dispatcher 层的防抖器
  const d = ensureDebouncer(config);
  await d.enqueue({ msg, isGroup, account, config, core, wsClient, log, statusSink, abortSignal });
}
