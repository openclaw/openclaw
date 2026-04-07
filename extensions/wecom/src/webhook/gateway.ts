/**
 * Webhook Gateway lifecycle management
 *
 * Migrated from @mocrane/wecom gateway-monitor.ts (webhook portion only).
 * Responsibilities: state initialization, Target registration, start/stop management.
 *
 * Key design:
 * - MonitorState is a global singleton (monitorState); all accounts share the same StreamStore and ActiveReplyStore
 * - Target registration/unregistration does not affect monitorState lifecycle; it only controls pruneTimer start/stop
 * - Each account registers multiple paths (legacy path + recommended path + multi-account path)
 * - Managed per accountId with their own unregister; stop only unregisters that account's Targets
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { hasMultiAccounts } from "../accounts.js";
import { DEFAULT_ACCOUNT_ID } from "../openclaw-compat.js";
import { getWeComRuntime } from "../runtime.js";
import { startAgentForStream } from "./monitor.js";
import { monitorState, WebhookMonitorState } from "./state.js";
import { registerWecomWebhookTarget, hasActiveTargets } from "./target.js";
import type { WebhookGatewayContext, WecomWebhookTarget, PendingInbound } from "./types.js";
import { PRUNE_INTERVAL_MS, WEBHOOK_PATHS } from "./types.js";

// ============================================================================
// Global state
// ============================================================================

/** Per-accountId Target unregister functions */
const accountUnregisters = new Map<string, () => void>();

/** Whether the FlushHandler has been set (only needs to be set once since monitorState is a singleton) */
let flushHandlerInstalled = false;

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Deduplicate paths
 */
function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
}

/**
 * Resolve Bot Target registration paths
 *
 * Multi-account scenario (matrixMode): register paths with accountId suffix + legacy compatible paths
 * Single-account scenario: register only base paths
 *
 * Reference: lh version resolveBotRegistrationPaths
 */
function resolveBotRegistrationPaths(params: { accountId: string; matrixMode: boolean }): string[] {
  if (params.matrixMode) {
    return uniquePaths([
      `${WEBHOOK_PATHS.BOT_PLUGIN}/${params.accountId}`,
      `${WEBHOOK_PATHS.BOT_ALT}/${params.accountId}`,
      // Legacy compatible paths: without accountId suffix; signature verification auto-matches the correct account
      WEBHOOK_PATHS.BOT_PLUGIN,
      WEBHOOK_PATHS.BOT,
      WEBHOOK_PATHS.BOT_ALT,
    ]);
  }
  // Single-account mode: also register /default path to support explicit specification
  return uniquePaths([
    WEBHOOK_PATHS.BOT_PLUGIN,
    WEBHOOK_PATHS.BOT,
    WEBHOOK_PATHS.BOT_ALT,
    `${WEBHOOK_PATHS.BOT_PLUGIN}/${DEFAULT_ACCOUNT_ID}`,
    `${WEBHOOK_PATHS.BOT_ALT}/${DEFAULT_ACCOUNT_ID}`,
  ]);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the current MonitorState instance (global singleton)
 *
 * Used by monitor.ts and other internal modules to access StreamStore and ActiveReplyStore.
 */
export function getMonitorState(): WebhookMonitorState {
  return monitorState;
}

/**
 * Start the Webhook Gateway
 *
 * 1. Validate webhook configuration
 * 2. Ensure pruneTimer is started
 * 3. Set FlushHandler (first time only)
 * 4. Resolve and register multiple webhook paths
 */
export function startWebhookGateway(ctx: WebhookGatewayContext): void {
  const { account, config, runtime } = ctx;
  const log = ctx.log ?? {
    info: (msg: string) => runtime.log(msg),
    error: (msg: string) => runtime.error(msg),
  };

  // 1. Validate required config (receiveId is optional and can be empty)
  if (!account.token || !account.encodingAESKey) {
    const missing: string[] = [];
    if (!account.token) {
      missing.push("token");
    }
    if (!account.encodingAESKey) {
      missing.push("encodingAESKey");
    }

    const errorMsg = `[webhook] Webhook 配置不完整，缺少: ${missing.join(", ")}`;
    log.error(errorMsg);

    ctx.setStatus?.({
      accountId: ctx.accountId,
      running: false,
      configured: false,
      lastError: errorMsg,
    });
    return;
  }

  log.info(`[webhook] 启动 Webhook Gateway (accountId=${ctx.accountId})`);

  // 2. Ensure pruneTimer is started (idempotent: does not restart if already running)
  monitorState.startPruning(PRUNE_INTERVAL_MS);

  // 3. Set FlushHandler (first time only, since monitorState is a global singleton)
  if (!flushHandlerInstalled) {
    monitorState.streamStore.setFlushHandler((pending) => void flushPending(pending));
    flushHandlerInstalled = true;
  }

  // 4. Build Target context
  const runtimeEnv = {
    log: (msg: string) => runtime.log(msg),
    error: (msg: string) => runtime.error(msg),
  };

  // Determine whether multi-account mode is active
  const matrixMode = hasMultiAccounts(ctx.config);

  const target: WecomWebhookTarget = {
    account,
    config,
    runtime: runtimeEnv,
    core: (ctx.channelRuntime ?? runtime) as PluginRuntime, // PluginRuntime instance
    path: `${WEBHOOK_PATHS.BOT_PLUGIN}/${ctx.accountId}`, // Primary path (for logging and status display)
    statusSink: ctx.setStatus
      ? (patch) => ctx.setStatus?.({ accountId: ctx.accountId, ...patch })
      : undefined,
  };

  // 5. Resolve registration paths
  const paths = resolveBotRegistrationPaths({
    accountId: ctx.accountId,
    matrixMode,
  });

  // 6. Register Target (returns unregister function)
  // If this account was previously registered (e.g. reload), unregister first
  const existingUnregister = accountUnregisters.get(ctx.accountId);
  if (existingUnregister) {
    existingUnregister();
  }

  const unregister = registerWecomWebhookTarget(target, paths);
  accountUnregisters.set(ctx.accountId, unregister);

  log.info(
    `[webhook] Webhook Target 已注册 (accountId=${ctx.accountId}, paths=[${paths.join(", ")}])`,
  );

  // 7. Update status
  ctx.setStatus?.({
    accountId: ctx.accountId,
    running: true,
    configured: true,
    webhookPath: paths[0],
    lastStartAt: Date.now(),
  });
}

/**
 * Stop the Webhook Gateway
 *
 * 1. Unregister this account's Targets (does not affect other accounts)
 * 2. If no active Targets remain, stop the prune timer
 */
export function stopWebhookGateway(ctx: WebhookGatewayContext): void {
  const log = ctx.log ?? {
    info: (msg: string) => ctx.runtime.log(msg),
    error: (msg: string) => ctx.runtime.error(msg),
  };

  log.info(`[webhook] 停止 Webhook Gateway (accountId=${ctx.accountId})`);

  // 1. Unregister this account's Targets
  const unregister = accountUnregisters.get(ctx.accountId);
  if (unregister) {
    unregister();
    accountUnregisters.delete(ctx.accountId);
  }

  // 2. If no active Targets remain, stop pruneTimer
  if (!hasActiveTargets()) {
    monitorState.stopPruning();
  }

  // 3. Update status
  ctx.setStatus?.({
    accountId: ctx.accountId,
    running: false,
    lastStopAt: Date.now(),
  });
}

// ============================================================================
// flushPending middleware (aligned with original monitor.ts:1151-1192)
// ============================================================================

/**
 * **flushPending (flush pending messages / core Agent trigger point)**
 *
 * Called when the debounce timer expires.
 * Core logic:
 * 1. Aggregate all pending message contents (for context).
 * 2. Get PluginRuntime.
 * 3. Mark Stream as Started.
 * 4. Call `startAgentForStream` to launch the Agent workflow.
 * 5. Handle exceptions and update Stream status to Error.
 */
async function flushPending(pending: PendingInbound): Promise<void> {
  const { streamId, target, msg, contents, msgids, conversationKey, batchKey } = pending;
  const { streamStore } = monitorState;

  // Merge all message contents (each is already formatted by buildInboundBody)
  const mergedContents = contents
    .filter((c) => c.trim())
    .join("\n")
    .trim();

  let core: PluginRuntime | null = null;
  try {
    core = getWeComRuntime();
  } catch (err) {
    target.runtime.log?.(`[webhook] flush pending: runtime not ready: ${String(err)}`);
    streamStore.markFinished(streamId);
    target.runtime.log?.(`[webhook] queue: runtime not ready，结束批次并推进 streamId=${streamId}`);
    streamStore.onStreamFinished(streamId);
    return;
  }

  if (core) {
    streamStore.markStarted(streamId);
    const enrichedTarget: WecomWebhookTarget = { ...target, core };
    target.runtime.log?.(
      `[webhook] flush pending: start batch streamId=${streamId} batchKey=${batchKey} conversationKey=${conversationKey} mergedCount=${contents.length}`,
    );

    // Pass the first msg (with its media structure), and mergedContents for multi-message context
    startAgentForStream({
      target: enrichedTarget,
      accountId: target.account.accountId,
      msg,
      streamId,
      mergedContents: contents.length > 1 ? mergedContents : undefined,
      mergedMsgids: msgids.length > 1 ? msgids : undefined,
    }).catch((err) => {
      streamStore.updateStream(streamId, (state) => {
        state.error = err instanceof Error ? err.message : String(err);
        state.content = state.content || `Error: ${state.error}`;
        state.finished = true;
      });
      target.runtime.error?.(`[webhook] Agent 处理失败 (streamId=${streamId}): ${String(err)}`);
      streamStore.onStreamFinished(streamId);
    });
  }
}
