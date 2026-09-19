/**
 * Gateway loop for polling ClickClack backlog events, opening the realtime
 * websocket, and dispatching user messages into OpenClaw.
 */
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
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
// Current servers attach uploads before message.created. Older servers emit one
// message.updated per linked upload, so finalize only after a bounded quiet window.
const CLICKCLACK_ATTACHMENT_LINK_GRACE_MS = 1_500;
const CLICKCLACK_ATTACHMENT_LINK_MAX_WAIT_MS = 5_000;
const CLICKCLACK_PENDING_MESSAGE_LIMIT = 512;
const CLICKCLACK_COMPLETED_MESSAGE_LIMIT = 1_024;

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

function isCreatedMessageEvent(event: ClickClackEvent): boolean {
  return event.type === "message.created" || event.type === "thread.reply_created";
}

type PendingMessageEvent = {
  event: ClickClackEvent;
  messageId: string;
  ready: Promise<void>;
  sawUpdate: boolean;
  noteUpdate: () => void;
  release: () => void;
};

function createMessageEventCoalescer(params: {
  abortSignal: AbortSignal;
  botUserId: string;
  processCreatedEvent: (
    event: ClickClackEvent,
    waitForLegacyUpdates: () => Promise<boolean>,
  ) => Promise<number | undefined>;
  inspectLateUpdate: (event: ClickClackEvent, attachmentCount: number) => Promise<void>;
}) {
  const pendingByMessageId = new Map<string, PendingMessageEvent>();
  const pendingByEvent = new WeakMap<ClickClackEvent, PendingMessageEvent>();
  const completedMessages = new Map<string, number>();

  const rememberCompleted = (messageId: string, attachmentCount: number) => {
    completedMessages.delete(messageId);
    completedMessages.set(messageId, attachmentCount);
    while (completedMessages.size > CLICKCLACK_COMPLETED_MESSAGE_LIMIT) {
      const oldestMessageId = completedMessages.keys().next().value;
      if (oldestMessageId === undefined) {
        break;
      }
      completedMessages.delete(oldestMessageId);
    }
  };

  const createPending = (event: ClickClackEvent, messageId: string): PendingMessageEvent => {
    let released = false;
    let resolveReady: () => void = () => undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const startTimer = () => {
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(() => pending.release(), CLICKCLACK_ATTACHMENT_LINK_GRACE_MS);
    };
    const pending: PendingMessageEvent = {
      event,
      messageId,
      ready,
      sawUpdate: false,
      noteUpdate: () => {
        pending.sawUpdate = true;
        if (!released) {
          startTimer();
        }
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (quietTimer) {
          clearTimeout(quietTimer);
          quietTimer = undefined;
        }
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        resolveReady();
      },
    };
    startTimer();
    deadlineTimer = setTimeout(pending.release, CLICKCLACK_ATTACHMENT_LINK_MAX_WAIT_MS);
    return pending;
  };

  const observe = (event: ClickClackEvent) => {
    const messageId = payloadString(event, "message_id");
    if (!messageId) {
      return;
    }
    if (event.type === "message.updated") {
      const pending = pendingByMessageId.get(messageId);
      if (pending) {
        pendingByEvent.set(event, pending);
        pending.noteUpdate();
      }
      return;
    }
    if (!isCreatedMessageEvent(event)) {
      return;
    }
    if (payloadString(event, "author_id") === params.botUserId) {
      return;
    }
    if (completedMessages.has(messageId)) {
      return;
    }
    const existing = pendingByMessageId.get(messageId);
    if (existing) {
      pendingByEvent.set(event, existing);
      return;
    }
    if (pendingByMessageId.size >= CLICKCLACK_PENDING_MESSAGE_LIMIT) {
      const oldest = pendingByMessageId.values().next().value;
      if (oldest) {
        pendingByMessageId.delete(oldest.messageId);
        oldest.release();
      }
    }
    const pending = createPending(event, messageId);
    pendingByMessageId.set(messageId, pending);
    pendingByEvent.set(event, pending);
  };

  const process = async (event: ClickClackEvent) => {
    const messageId = payloadString(event, "message_id");
    if (!isCreatedMessageEvent(event)) {
      if (event.type === "message.updated" && messageId && !pendingByEvent.has(event)) {
        const attachmentCount = completedMessages.get(messageId);
        if (attachmentCount !== undefined) {
          await params.inspectLateUpdate(event, attachmentCount);
        }
      }
      return;
    }
    if (messageId && completedMessages.has(messageId)) {
      return;
    }
    observe(event);
    const pending = pendingByEvent.get(event);
    if (!pending) {
      await params.processCreatedEvent(event, async () => false);
      return;
    }
    try {
      const attachmentCount = await params.processCreatedEvent(pending.event, async () => {
        await pending.ready;
        return pending.sawUpdate;
      });
      if (!params.abortSignal.aborted && attachmentCount !== undefined) {
        rememberCompleted(messageId, attachmentCount);
      }
    } finally {
      if (pendingByMessageId.get(messageId) === pending) {
        pendingByMessageId.delete(messageId);
      }
      pending.release();
    }
  };

  const close = () => {
    for (const pending of pendingByMessageId.values()) {
      pending.release();
    }
    pendingByMessageId.clear();
  };
  params.abortSignal.addEventListener("abort", close, { once: true });

  return {
    observe,
    process,
    close: () => {
      params.abortSignal.removeEventListener("abort", close);
      close();
    },
  };
}

function parseSocketEvent(data: RawData): ClickClackEvent | null {
  try {
    return JSON.parse(rawDataToString(data)) as ClickClackEvent;
  } catch {
    return null;
  }
}

async function processEvent(params: {
  abortSignal: AbortSignal;
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  client: ReturnType<typeof createClickClackClient>;
  event: ClickClackEvent;
  botUserId: string;
  waitForLegacyUpdates: () => Promise<boolean>;
  buildContext?: typeof buildChannelInboundEventContext;
  log?: { info: (message: string) => void; warn?: (message: string) => void };
}): Promise<number | undefined> {
  if (!isCreatedMessageEvent(params.event)) {
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
  let message = await resolveEventMessage({
    client: messageClient,
    event: params.event,
  });
  if (!message) {
    params.log?.warn?.(
      `[${params.account.accountId}] skipped unreadable ClickClack message before agent dispatch: ` +
        `type=${params.event.type} messageId=${payloadString(params.event, "message_id") || "unknown"}`,
    );
    return undefined;
  }
  // A nonempty fetch can still be a partial legacy attachment set. Only the
  // event quiet window, bounded by its independent deadline, marks completion.
  const sawLegacyUpdate = await params.waitForLegacyUpdates();
  if (params.abortSignal.aborted) {
    return undefined;
  }
  if (sawLegacyUpdate) {
    message = await resolveEventMessage({ client: messageClient, event: params.event });
    if (!message) {
      return undefined;
    }
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
  await handleClickClackInbound({
    account: params.account,
    config: params.config,
    message,
    access,
    abortSignal: params.abortSignal,
    buildContext: params.buildContext,
    ...(correlationId ? { correlationId } : {}),
  });
  return message.attachments?.length ?? 0;
}

async function inspectLateAttachmentUpdate(params: {
  client: ReturnType<typeof createClickClackClient>;
  event: ClickClackEvent;
  attachmentCount: number;
  accountId: string;
  log?: { warn?: (message: string) => void };
}) {
  const message = await resolveEventMessage({ client: params.client, event: params.event });
  const currentCount = message?.attachments?.length ?? 0;
  if (currentCount > params.attachmentCount) {
    params.log?.warn?.(
      `[${params.accountId}] ClickClack attachment linked after the bounded legacy window; ` +
        `messageId=${payloadString(params.event, "message_id")} ` +
        `processed=${params.attachmentCount} current=${currentCount}`,
    );
  }
}

async function drainEventBacklog(params: {
  client: ReturnType<typeof createClickClackClient>;
  workspaceId: string;
  afterCursor: string;
  abortSignal: AbortSignal;
  observeEvent: (event: ClickClackEvent) => void;
  onEvent: (event: ClickClackEvent) => Promise<void>;
}): Promise<string> {
  let afterCursor = params.afterCursor;
  while (!params.abortSignal.aborted) {
    const page = await params.client.eventPage(params.workspaceId, {
      afterCursor,
      limit: CLICKCLACK_EVENT_PAGE_LIMIT,
    });
    const events = page.events;
    // Observation is non-dispatching: it groups every update in this page with
    // its create before ordered cursor processing reaches it.
    for (const event of events) {
      params.observeEvent(event);
    }
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
  const coalescer = createMessageEventCoalescer({
    abortSignal: ctx.abortSignal,
    botUserId: account.botUserId,
    processCreatedEvent: (event, waitForLegacyUpdates) =>
      processEvent({
        abortSignal: ctx.abortSignal,
        account,
        config: ctx.cfg,
        client,
        event,
        botUserId: account.botUserId,
        waitForLegacyUpdates,
        buildContext: (ctx.channelRuntime as PluginRuntime["channel"] | undefined)?.inbound
          .buildContext,
        log: ctx.log,
      }),
    inspectLateUpdate: (event, attachmentCount) =>
      inspectLateAttachmentUpdate({
        client,
        event,
        attachmentCount,
        accountId: account.accountId,
        log: ctx.log,
      }),
  });
  const processIncomingEvent = coalescer.process;
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
      } else {
        afterCursor = await drainEventBacklog({
          client,
          workspaceId,
          afterCursor,
          abortSignal: ctx.abortSignal,
          observeEvent: coalescer.observe,
          onEvent: processIncomingEvent,
        });
      }
      if (ctx.abortSignal.aborted) {
        break;
      }
      const socket = client.websocket(workspaceId, afterCursor);
      await new Promise<void>((resolve) => {
        let settled = false;
        let closing = false;
        let loggedMessageFailure = false;
        let messageQueue = Promise.resolve();
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
          void messageQueue.then(
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
          // Observe updates before the ordered queue so every legacy attachment
          // link extends the matching create's bounded quiet window.
          coalescer.observe(event);
          // Preserve server event order and commit each cursor only after its
          // handler succeeds, so reconnect backlog can retry a failed event.
          messageQueue = messageQueue.then(async () => {
            if (ctx.abortSignal.aborted) {
              return;
            }
            await processIncomingEvent(event);
            afterCursor = event.cursor || afterCursor;
          });
          void messageQueue.catch(reconnectAfterMessageFailure);
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
    coalescer.close();
    ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
  }
}
