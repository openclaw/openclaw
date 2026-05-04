/**
 * Phase 1B.1 lifecycle adapter.
 *
 * Wraps the polling supervisor in `runStoppablePassiveMonitor` so the
 * gateway's `ctx.abortSignal` drives shutdown (per
 * docs/max-plugin/plan.md §6.1.3). Internally:
 *
 *   1. Validate the resolved account has a token + apiRoot.
 *   2. Start `runMaxPollingSupervisor` with a child `AbortController` linked
 *      to `ctx.abortSignal`.
 *   3. Surface fatal terminal states (`unauthorized`) through `ctx.setStatus`
 *      so `openclaw status` reflects the channel's true health.
 *
 * `start(ctx)` is the long-running call and resolves only after the gateway
 * aborts the account. `stop(ctx)` exists for symmetry with the gateway
 * adapter but does no extra work — abort drives shutdown via
 * `runStoppablePassiveMonitor`.
 */

import type { ChannelGatewayContext, ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { handleMaxInbound, normalizeMaxInboundMessage } from "../inbound.js";
import {
  runMaxPollingSupervisor,
  type MaxPollingSupervisorResult,
} from "../polling/monitor-polling.runtime.js";
import type { PollingLogger, PollingUpdate } from "../polling/polling-loop.js";
import type { MaxEvent, MaxPollingConfig, MaxUpdateType, ResolvedMaxAccount } from "../types.js";
import type { CoreConfig } from "../types.js";
import { dispatchInboundEvent, type MaxInboundContext } from "./inbound.adapter.js";

/**
 * Locked polling defaults (per plan §8 rows 11-15). The schema in
 * `config-schema.ts` documents the same values via Zod `.default(...)`; the
 * resolver returns raw config (no schema parse), so these constants are the
 * runtime fallback when a field is omitted.
 */
const POLL_DEFAULT_TIMEOUT_SEC = 30;
const POLL_DEFAULT_RETRY_BACKOFF_MS = 1000;
const POLL_DEFAULT_MAX_BACKOFF_MS = 30_000;

function resolvePollingTunables(polling: MaxPollingConfig | undefined): {
  timeoutSec: number;
  retryBackoffMs: number;
  maxBackoffMs: number;
} {
  return {
    timeoutSec: polling?.timeoutSec ?? POLL_DEFAULT_TIMEOUT_SEC,
    retryBackoffMs: polling?.retryBackoffMs ?? POLL_DEFAULT_RETRY_BACKOFF_MS,
    maxBackoffMs: polling?.maxBackoffMs ?? POLL_DEFAULT_MAX_BACKOFF_MS,
  };
}

/**
 * Adapt the gateway `ChannelLogSink` (string-only) to the structured
 * `PollingLogger` the supervisor uses. Fields are JSON-stringified into the
 * message so they survive the simpler sink while remaining grep-able.
 */
function buildPollingLogger(log: ChannelLogSink | undefined, accountId: string): PollingLogger {
  const tag = `[max-messenger:${accountId}]`;
  const format = (message: string, fields?: Record<string, unknown>): string =>
    fields && Object.keys(fields).length > 0
      ? `${tag} ${message} ${JSON.stringify(fields)}`
      : `${tag} ${message}`;
  return {
    info: (message, fields) => log?.info?.(format(message, fields)),
    warn: (message, fields) => log?.warn?.(format(message, fields)),
    error: (message, fields) => log?.error?.(format(message, fields)),
  };
}

const KNOWN_UPDATE_TYPES: ReadonlySet<MaxUpdateType> = new Set<MaxUpdateType>([
  "bot_started",
  "message_created",
  "message_edited",
  "message_removed",
  "message_callback",
  "bot_added",
  "bot_removed",
  "user_added",
  "user_removed",
  "chat_title_changed",
]);

/**
 * Bridge supervisor `PollingUpdate` payloads into either the real agent
 * reply pipeline (`handleMaxInbound`) for `message_created` events or the
 * Phase 1A logging skeleton for everything else.
 *
 * Phase 1B.3 wires the message reply path; callback routing, attachments,
 * and membership events are still routed through the skeleton until later
 * phases pick them up.
 */
function buildSupervisorDispatch(params: {
  ctx: ChannelGatewayContext<ResolvedMaxAccount>;
  inboundCtx: MaxInboundContext;
}): (update: PollingUpdate) => Promise<void> {
  const { ctx, inboundCtx } = params;
  const account = ctx.account;
  const statusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }): void => {
    const snapshot = ctx.getStatus();
    ctx.setStatus({ ...snapshot, ...patch });
  };
  return async (update) => {
    if (update.update_type === "message_created") {
      const message = normalizeMaxInboundMessage(update);
      if (!message) {
        // Malformed update payload — log via the skeleton for visibility but
        // don't drag the agent pipeline through it.
        ctx.log?.warn?.(
          `[max-messenger:${account.accountId}] message_created without usable mid/chat/sender — dropping`,
        );
        return;
      }
      try {
        await handleMaxInbound({
          message,
          account,
          config: ctx.cfg as CoreConfig,
          runtime: ctx.runtime,
          statusSink,
        });
      } catch (err) {
        ctx.log?.error?.(
          `[max-messenger:${account.accountId}] handleMaxInbound threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    const updateType = KNOWN_UPDATE_TYPES.has(update.update_type as MaxUpdateType)
      ? (update.update_type as MaxUpdateType)
      : undefined;
    if (!updateType) {
      const annotated: MaxEvent = {
        update_type: update.update_type as MaxUpdateType,
        timestamp: typeof update.timestamp === "number" ? update.timestamp : Date.now(),
      };
      dispatchInboundEvent(inboundCtx, annotated);
      return;
    }
    const event: MaxEvent = {
      update_type: updateType,
      timestamp: typeof update.timestamp === "number" ? update.timestamp : Date.now(),
      payload: update,
    };
    dispatchInboundEvent(inboundCtx, event);
  };
}

export const maxMessengerLifecycleAdapter = {
  async start(ctx: ChannelGatewayContext<ResolvedMaxAccount>): Promise<void> {
    const account = ctx.account;
    if (!account.token) {
      throw new Error(
        `MAX Messenger: token missing for account "${account.accountId}". ` +
          "Provide channels.max-messenger.token, channels.max-messenger.tokenFile, " +
          "or set MAX_BOT_TOKEN.",
      );
    }
    if (!account.apiRoot) {
      throw new Error(`MAX Messenger: apiRoot missing for account "${account.accountId}".`);
    }

    const pollingLogger = buildPollingLogger(ctx.log, account.accountId);
    const inboundCtx: MaxInboundContext = {
      accountId: account.accountId,
      log: { info: (msg) => ctx.log?.info?.(msg) },
    };
    const dispatch = buildSupervisorDispatch({ ctx, inboundCtx });
    const tunables = resolvePollingTunables(account.config.polling);

    pollingLogger.info("max-messenger.polling.start", {
      apiRoot: account.apiRoot,
      tokenSource: account.tokenSource,
      polling: tunables,
    });

    await runStoppablePassiveMonitor({
      abortSignal: ctx.abortSignal,
      start: async () => {
        const internalCtrl = new AbortController();
        const linkAbort = (): void => internalCtrl.abort();
        if (ctx.abortSignal.aborted) {
          internalCtrl.abort();
        } else {
          ctx.abortSignal.addEventListener("abort", linkAbort, { once: true });
        }

        // Kick off the supervisor; it self-resolves on stopSignal abort or 401.
        const supervisorPromise: Promise<MaxPollingSupervisorResult> = runMaxPollingSupervisor({
          apiRoot: account.apiRoot,
          token: account.token,
          accountId: account.accountId,
          timeoutSec: tunables.timeoutSec,
          retryBackoffMs: tunables.retryBackoffMs,
          maxBackoffMs: tunables.maxBackoffMs,
          dispatch,
          abortSignal: internalCtrl.signal,
          log: pollingLogger,
        });

        // Surface the terminal state (unauthorized → status flip) without
        // letting the promise leak as an unhandled rejection.
        supervisorPromise
          .then((reason) => {
            if (reason === "unauthorized") {
              pollingLogger.error("max-messenger.polling.fatal.surface_status", {
                accountId: account.accountId,
              });
              const snapshot = ctx.getStatus();
              ctx.setStatus({
                ...snapshot,
                running: false,
                tokenStatus: "unauthorized",
                lastError: "MAX bot token rejected by API (HTTP 401).",
                lastDisconnect: { at: Date.now(), status: 401, error: "unauthorized" },
              });
            } else {
              pollingLogger.info("max-messenger.polling.stop", { reason });
            }
          })
          .catch((err: unknown) => {
            pollingLogger.error("max-messenger.polling.crashed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });

        return {
          stop: () => {
            internalCtrl.abort();
          },
        };
      },
    });
  },
  async stop(ctx: ChannelGatewayContext<ResolvedMaxAccount>): Promise<void> {
    // Abort drives shutdown via `runStoppablePassiveMonitor`; the explicit
    // stopAccount call is here for symmetry with the gateway adapter.
    ctx.log?.info?.(`[max-messenger:${ctx.account.accountId}] stop requested`);
  },
};
