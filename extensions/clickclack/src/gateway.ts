import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { stripMentions, stripStructuralPrefixes } from "openclaw/plugin-sdk/channel-mention-gating";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { RawData } from "ws";
import { resolveClickClackInboundAccess } from "./access.js";
import { resolveClickClackAccount } from "./accounts.js";
import { syncClickClackCommandMenu } from "./command-menu.js";
import {
  ClickClackHttpError,
  createClickClackClient,
  normalizeClickClackCorrelationId,
} from "./http-client.js";
import { handleClickClackInbound } from "./inbound.js";
import { resolveWorkspaceId } from "./resolve.js";
import type {
  ClickClackEvent,
  ClickClackMessage,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

const CLICKCLACK_EVENT_PAGE_LIMIT = 500;

function payloadString(event: ClickClackEvent, key: string): string {
  return readStringField(event.payload, key) ?? "";
}

function eventCorrelationId(event: ClickClackEvent): string | undefined {
  return normalizeClickClackCorrelationId(event.payload?.correlation_id);
}

async function resolveEventMessage(params: {
  client: ReturnType<typeof createClickClackClient>;
  event: ClickClackEvent;
}): Promise<ClickClackMessage | null> {
  const messageId = payloadString(params.event, "message_id");
  if (!messageId) {
    return null;
  }
  try {
    return await params.client.message(messageId);
  } catch (error) {
    if (error instanceof ClickClackHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function parseSocketEvent(data: RawData): ClickClackEvent | null {
  try {
    return JSON.parse(rawDataToString(data)) as ClickClackEvent;
  } catch {
    return null;
  }
}

async function resolveInboundEvent(params: {
  abortSignal: AbortSignal;
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  client: ReturnType<typeof createClickClackClient>;
  event: ClickClackEvent;
  botUserId: string;
  buildContext?: typeof buildChannelInboundEventContext;
  log?: { info: (message: string) => void; warn?: (message: string) => void };
}) {
  if (params.event.type !== "message.created" && params.event.type !== "thread.reply_created") {
    return undefined;
  }
  if (params.abortSignal.aborted || payloadString(params.event, "author_id") === params.botUserId) {
    return undefined;
  }
  const correlationId = eventCorrelationId(params.event);
  // The event body is only a routing hint. Re-fetch the authoritative message
  // under the same safe correlation id before dispatching any model work.
  const messageClient = correlationId
    ? createClickClackClient({
        baseUrl: params.account.apiEndpoint,
        token: params.account.token,
        correlationId,
      })
    : params.client;
  const message = await resolveEventMessage({ client: messageClient, event: params.event });
  if (!message) {
    params.log?.warn?.(
      `[${params.account.accountId}] skipped unreadable ClickClack message before agent dispatch: ` +
        `type=${params.event.type} messageId=${payloadString(params.event, "message_id") || "unknown"}`,
    );
    return undefined;
  }
  if (params.abortSignal.aborted || message.author_id === params.botUserId) {
    return undefined;
  }
  const access = await resolveClickClackInboundAccess({
    account: params.account,
    config: params.config,
    message,
  });
  // Account shutdown can race either awaited lookup; retired generations must never start a turn.
  if (params.abortSignal.aborted) {
    return undefined;
  }
  if (!access.shouldDispatch) {
    params.log?.info(
      `[${params.account.accountId}] skipped ClickClack message before agent dispatch: ` +
        `kind=${message.direct_conversation_id ? "dm" : "group"} ` +
        `requireMention=${access.requireMention ?? "unknown"} ` +
        `wasMentioned=${access.mentionFacts.wasMentioned} ` +
        `hasAnyMention=${access.mentionFacts.hasAnyMention ?? "unknown"} ` +
        `commandAuthorized=${access.commandAuthorized}`,
    );
    return undefined;
  }
  return { message, access, correlationId };
}

async function prepareEvent(
  params: Parameters<typeof resolveInboundEvent>[0] & { onEventError: (error: unknown) => never },
) {
  const prepared = await resolveInboundEvent(params);
  if (!prepared) {
    return undefined;
  }
  const { message, access } = prepared;
  const commandText = stripStructuralPrefixes(message.body);
  const normalizedCommandText = message.direct_conversation_id
    ? commandText
    : stripMentions(
        commandText,
        { Provider: "clickclack" },
        params.config,
        access.preparedRoute?.route.agentId,
      );
  const interrupt =
    (params.account.replyMode === "agent" || Boolean(access.preparedRoute?.discussionRoute)) &&
    access.commandAuthorized &&
    isAbortRequestText(normalizedCommandText);
  return {
    interrupt,
    dispatch: async (assertCurrent: () => void, getInterruptBarrier: () => Promise<void>) => {
      if (params.abortSignal.aborted) {
        return;
      }
      let current = interrupt ? prepared : undefined;
      if (!interrupt) {
        // A stop can arrive while this reply waits or refreshes its route.
        // Re-read after that stop settles before starting ordinary work.
        let barrier: Promise<void>;
        do {
          barrier = getInterruptBarrier();
          await barrier;
          assertCurrent();
          current = await resolveInboundEvent(params).catch(params.onEventError);
        } while (barrier !== getInterruptBarrier());
      }
      assertCurrent();
      if (params.abortSignal.aborted || !current) {
        return;
      }
      const { correlationId } = current;
      try {
        await handleClickClackInbound({
          account: params.account,
          config: params.config,
          message: current.message,
          access: current.access,
          buildContext: params.buildContext,
          ...(correlationId ? { correlationId } : {}),
        });
      } catch (error) {
        params.onEventError(error);
      }
    },
  };
}

async function drainEventBacklog(params: {
  client: ReturnType<typeof createClickClackClient>;
  workspaceId: string;
  afterCursor: string;
  abortSignal: AbortSignal;
  onEvent: (event: ClickClackEvent) => Promise<void>;
}): Promise<string> {
  let afterCursor = params.afterCursor;
  while (!params.abortSignal.aborted) {
    const page = await params.client.eventPage(params.workspaceId, {
      afterCursor,
      limit: CLICKCLACK_EVENT_PAGE_LIMIT,
    });
    const events = page.events;
    for (const event of events) {
      if (params.abortSignal.aborted) {
        return afterCursor;
      }
      if (!event.cursor || event.cursor === afterCursor) {
        throw new Error("ClickClack event backlog returned a non-advancing cursor");
      }
      await params.onEvent(event);
      afterCursor = event.cursor;
    }
    if (events.length === 0) {
      return afterCursor;
    }
  }
  return afterCursor;
}

export async function startClickClackGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedClickClackAccount>,
) {
  const configuredAccount = resolveClickClackAccount({
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
  });
  if (!configuredAccount.configured) {
    throw new Error(`ClickClack is not configured for account "${configuredAccount.accountId}"`);
  }
  const client = createClickClackClient({
    baseUrl: configuredAccount.apiEndpoint,
    token: configuredAccount.token,
  });
  const workspaceId = await resolveWorkspaceId(client, configuredAccount.workspace);
  const me = await client.me();
  const account = {
    ...configuredAccount,
    workspace: workspaceId,
    botUserId: configuredAccount.botUserId ?? me.id,
    botHandle: me.handle,
  };
  const prepareIncomingEvent = (event: ClickClackEvent, onEventError: (error: unknown) => never) =>
    prepareEvent({
      abortSignal: ctx.abortSignal,
      account,
      config: ctx.cfg,
      client,
      event,
      onEventError,
      botUserId: account.botUserId,
      buildContext: (ctx.channelRuntime as PluginRuntime["channel"] | undefined)?.inbound
        .buildContext,
      log: ctx.log,
    });
  if (account.commandMenu) {
    await syncClickClackCommandMenu({
      cfg: ctx.cfg,
      client,
      log: ctx.log,
      accountId: account.accountId,
    });
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let afterCursor = "";
  let initialized = false;
  try {
    while (!ctx.abortSignal.aborted) {
      let preparation = Promise.resolve();
      let replies = Promise.resolve();
      let interrupts = Promise.resolve();
      let acknowledgements = Promise.resolve();
      let failure: { error: unknown } | undefined;
      let replayFailure: { error: unknown } | undefined;
      let onFailure: ((error: unknown) => void) | undefined;
      const inFlight = new Set<Promise<void>>();
      const failed = (error: unknown) => {
        failure ??= { error };
        onFailure?.(error);
      };
      const enqueueEvent = (event: ClickClackEvent, replay = false) => {
        // Only errors from this event's own lookups/handler are replay errors.
        // Queue guards and rejected stop barriers may carry a live failure.
        const eventFailed = (error: unknown): never => {
          if (replay) {
            replayFailure ??= { error };
          }
          failed(error);
          throw error;
        };
        preparation = preparation.then(async () => {
          if (failure) {
            throw failure.error;
          }
          const prepared = await prepareIncomingEvent(event, eventFailed).catch(eventFailed);
          // Fetch and authorize in arrival order, but do not make an abort
          // wait for the reply it must cancel. Ordinary replies remain FIFO.
          const dispatch = async () => {
            if (failure) {
              throw failure.error;
            }
            await prepared?.dispatch(
              () => {
                if (failure) {
                  throw failure.error;
                }
              },
              () => interrupts,
            );
          };
          const handled = prepared?.interrupt ? dispatch() : replies.then(dispatch);
          // Keep stop settlement separate from reply FIFO: a reply queued
          // before this stop must also observe it without a dependency cycle.
          if (prepared?.interrupt) {
            interrupts = Promise.all([interrupts, handled]).then(() => undefined);
            void interrupts.catch(failed);
          } else {
            replies = handled;
          }
          inFlight.add(handled);
          void handled.then(
            () => inFlight.delete(handled),
            (error: unknown) => {
              inFlight.delete(handled);
              failed(error);
            },
          );
          // A fast control may finish first; recovery can acknowledge only
          // the contiguous successful prefix, never skip a failed reply.
          acknowledgements = acknowledgements.then(async () => {
            await handled;
            afterCursor = event.cursor || afterCursor;
          });
          void acknowledgements.catch(failed);
        });
        void preparation.catch(failed);
        return preparation;
      };
      const settleEvents = async () => {
        // A rejected prefix must not reconnect while a later control still
        // owns effects; settle admitted work before replaying the cursor.
        await Promise.allSettled([preparation]);
        await Promise.allSettled([acknowledgements, ...inFlight]);
        if (replayFailure) {
          throw replayFailure.error;
        }
        if (failure) {
          throw failure.error;
        }
      };
      let readCursor = afterCursor;
      if (!initialized) {
        const page = await client.eventPage(workspaceId, { includeTail: true });
        // Newer servers capture this cursor before listing the page, so events
        // created during startup remain eligible for websocket delivery.
        if (page.tailCursor !== undefined) {
          afterCursor = page.tailCursor;
        } else {
          // Older servers omit tail_cursor; preserve the shipped one-page
          // startup behavior instead of extending the history-skip window.
          for (const event of page.events) {
            afterCursor = event.cursor || afterCursor;
          }
        }
        initialized = true;
        readCursor = afterCursor;
      } else {
        try {
          readCursor = await drainEventBacklog({
            client,
            workspaceId,
            afterCursor,
            abortSignal: ctx.abortSignal,
            onEvent: (event) => enqueueEvent(event, true),
          });
        } catch (error) {
          failed(error);
          await settleEvents();
        }
      }
      if (ctx.abortSignal.aborted) {
        break;
      }
      const socket = client.websocket(workspaceId, readCursor);
      await new Promise<void>((resolve) => {
        let settled = false;
        let closing = false;
        let loggedMessageFailure = false;
        let removeAbortListener: (() => void) | undefined;
        const finishSocketCycle = () => {
          if (settled) {
            return;
          }
          settled = true;
          removeAbortListener?.();
          removeAbortListener = undefined;
          resolve();
        };
        const finishAfterQueuedMessages = () => {
          // The queue is scoped to this account/socket. Waiting here preserves
          // its contiguous cursor without blocking unrelated account streams.
          void settleEvents().then(
            () => finishSocketCycle(),
            () => finishSocketCycle(),
          );
        };
        const reconnectAfterMessageFailure = (error: unknown) => {
          if (settled || ctx.abortSignal.aborted) {
            return;
          }
          if (!loggedMessageFailure) {
            loggedMessageFailure = true;
            ctx.log?.warn?.(
              `[${account.accountId}] ClickClack event processing failed; reconnecting: ${
                error instanceof Error ? error.message : formatErrorMessage(error)
              }`,
            );
          }
          if (!closing) {
            // Keep the last successful cursor. Reconnect backlog will replay
            // this event; a repeated failure there remains a surfaced error.
            closing = true;
            socket.close();
          }
        };
        onFailure = reconnectAfterMessageFailure;
        if (failure) {
          const error = failure.error;
          queueMicrotask(() => reconnectAfterMessageFailure(error));
        }
        void preparation.catch(reconnectAfterMessageFailure);
        void acknowledgements.catch(reconnectAfterMessageFailure);
        const abort = () => {
          socket.close();
          finishSocketCycle();
        };
        ctx.abortSignal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => ctx.abortSignal.removeEventListener("abort", abort);
        socket.on("open", () => {
          ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
        });
        socket.on("message", (data) => {
          if (closing || settled) {
            return;
          }
          const event = parseSocketEvent(data);
          if (!event) {
            ctx.log?.warn?.(`[${account.accountId}] skipped malformed ClickClack websocket event`);
            return;
          }
          void enqueueEvent(event).catch(reconnectAfterMessageFailure);
        });
        socket.on("close", () => {
          closing = true;
          if (!ctx.abortSignal.aborted) {
            ctx.setStatus({
              accountId: account.accountId,
              connected: false,
              lifecycle: "recovering",
            });
          }
          finishAfterQueuedMessages();
        });
        socket.on("error", (error) => {
          if (settled || ctx.abortSignal.aborted) {
            finishSocketCycle();
            return;
          }
          if (closing) {
            return;
          }
          ctx.log?.warn?.(
            `[${account.accountId}] ClickClack websocket error; reconnecting: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          ctx.setStatus({
            accountId: account.accountId,
            connected: false,
            lifecycle: "recovering",
            lastError: error instanceof Error ? error.message : String(error),
          });
          closing = true;
          socket.close();
        });
      });
      // Replay admission can finish before its handlers. Preserve terminal
      // replay errors after the socket cycle has settled all admitted work.
      if (replayFailure) {
        throw replayFailure.error;
      }
      if (!ctx.abortSignal.aborted) {
        try {
          // The gateway abort owns both the active socket and its reconnect delay;
          // otherwise shutdown can remain pending for the full configured backoff.
          await sleepWithAbort(account.reconnectMs, ctx.abortSignal);
        } catch (error) {
          if (!ctx.abortSignal.aborted) {
            throw error;
          }
        }
      }
    }
  } finally {
    ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
  }
}
