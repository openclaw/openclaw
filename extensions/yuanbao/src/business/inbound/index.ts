/**
 * Message inbound processing module.
 *
 * Unified entry point, single responsibility:
 * - System callbacks (Recall, etc.) dispatched synchronously, not debounced
 * - Normal messages delegated to dispatcher/debouncer for debounce + session-level serialization
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import { ensureDebouncer } from "../../dispatcher/debouncer/index.js";
import "../messaging/callbacks/recall.js";
import { createLog } from "../../logger.js";
import type { ModuleLog } from "../../logger.js";
import type { YuanbaoInboundMessage, ResolvedYuanbaoAccount } from "../../types.js";
import { dispatchSystemCallback } from "../messaging/system-callbacks.js";

// ============ Unified entry ============

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
 * Unified message processing entry.
 *
 * System callbacks (recall, etc.) are dispatched synchronously, not debounced;
 * normal messages are delegated to the dispatcher debouncer for debounce + session-level serialization.
 */
export async function handleInboundMessage(params: InboundMessageParams): Promise<void> {
  const { msg, isGroup, account, config, core, wsClient, log, statusSink, abortSignal } = params;

  // System callbacks (Recall, etc.): dispatched synchronously, not entering debounce queue
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

  // Delegate to dispatcher debouncer
  const d = ensureDebouncer(config);
  await d.enqueue({ msg, isGroup, account, config, core, wsClient, log, statusSink, abortSignal });
}
