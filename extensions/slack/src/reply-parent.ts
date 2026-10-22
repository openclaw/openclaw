import type { WebClient, WebClientOptions } from "@slack/web-api";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { resolveSlackOperationToken, type ResolvedSlackAccount } from "./accounts.js";
import { withSlackDnsRequestRetry } from "./client-delivery.js";
import { createSlackLookupClient } from "./client.js";
import { getSlackWebApiErrorData } from "./errors.js";
import type { SlackEventScope } from "./monitor/event-scope.js";

async function hasLiveReplyParent(
  client: WebClient,
  channel: string,
  ts: string,
): Promise<boolean> {
  const readMessage = async (timestamp: string) => {
    const response = await withSlackDnsRequestRetry("conversations.history", () =>
      client.conversations.history({
        channel,
        oldest: timestamp,
        latest: timestamp,
        inclusive: true,
        limit: 1,
      }),
    );
    if (!response.ok) {
      throw new Error(response.error ?? "Slack parent lookup failed");
    }
    return response.messages?.find((message) => message.ts === timestamp);
  };
  const isLive = (message: { ts?: string; subtype?: string } | undefined) =>
    Boolean(
      message?.ts && message.subtype !== "tombstone" && message.subtype !== "message_deleted",
    );
  const message = await readMessage(ts);
  if (message) {
    return (
      isLive(message) &&
      (!message.thread_ts ||
        message.thread_ts === ts ||
        isLive(await readMessage(message.thread_ts)))
    );
  }
  // Slack also accepts a child timestamp. Children are absent from channel
  // history; resolve its root, then require that root to still exist.
  const replies = await withSlackDnsRequestRetry("conversations.replies", () =>
    client.conversations.replies({ channel, ts, limit: 1 }),
  ).catch((error: unknown) => {
    if (getSlackWebApiErrorData(error)?.error === "thread_not_found") {
      return undefined;
    }
    throw error;
  });
  if (!replies || replies.error === "thread_not_found") {
    return false;
  }
  if (!replies.ok) {
    throw new Error(replies.error ?? "Slack parent lookup failed");
  }
  const parent = replies.messages?.[0];
  const rootTs = parent?.thread_ts ?? parent?.ts;
  return Boolean(rootTs && rootTs !== ts && isLive(parent) && isLive(await readMessage(rootTs)));
}

async function assertSlackReplyParent(
  clients: readonly WebClient[],
  channelId: string,
  threadTs: string,
): Promise<void> {
  let lookupError: unknown;
  for (const client of clients) {
    try {
      if (await hasLiveReplyParent(client, channelId, threadTs)) {
        return;
      }
    } catch (error) {
      lookupError = error;
    }
  }
  if (lookupError) {
    throw new PlatformMessageNotDispatchedError(
      "Could not verify Slack reply parent; message not sent. Do not resend at channel top level.",
      { cause: lookupError },
    );
  }
  throw new PlatformMessageNotDispatchedError(
    "Slack reply parent is missing or deleted; message not sent. Do not resend at channel top level.",
    { cause: undefined, retryable: false },
  );
}

export function createSlackReplyDispatch(
  params: {
    account: ResolvedSlackAccount;
    eventScope?: SlackEventScope;
    recipient: { teamId?: string };
    opts: {
      threadTs?: string;
      client?: WebClient;
      clientOptions?: WebClientOptions;
      assertDirectAdapterHandoff?: () => void;
      onPlatformSendDispatch?: () => Promise<void>;
    };
  },
  credential: string,
): (channelId: string) => Promise<void> {
  const { opts, eventScope, recipient } = params;
  let clients: WebClient[] = [];
  if (opts.threadTs) {
    if (eventScope && !eventScope.clientOptions) {
      clients = [eventScope.client];
    } else if (
      !eventScope &&
      opts.client &&
      !opts.clientOptions &&
      !recipient.teamId &&
      !opts.assertDirectAdapterHandoff
    ) {
      // External injected clients own their transport policy. Internal listeners
      // pass their options so lookups can use a separate bounded read client.
      clients = [opts.client];
    } else {
      const listener =
        eventScope?.client ??
        (!recipient.teamId && !opts.assertDirectAdapterHandoff ? opts.client : undefined);
      const writeToken = listener?.token ?? credential;
      // Monitor replies pass the account writer explicitly; preserve its reader.
      // Enterprise and unrelated custom credentials must stay isolated.
      const readToken =
        !eventScope && writeToken === resolveSlackOperationToken(params.account, "write")
          ? (resolveSlackOperationToken(params.account, "read") ?? writeToken)
          : writeToken;
      const options = eventScope?.clientOptions ?? opts.clientOptions;
      const headers = Object.fromEntries(
        Object.entries(options?.headers ?? {}).filter(
          ([name]) => name.toLowerCase() !== "authorization",
        ),
      );
      clients = [...new Set([readToken, writeToken])].map((token) =>
        createSlackLookupClient(
          token,
          {
            ...options,
            headers: { ...headers },
            ...(listener ? { slackApiUrl: listener.slackApiUrl } : {}),
            teamId: eventScope?.teamId ?? recipient.teamId,
            timeout: undefined,
          },
          opts.assertDirectAdapterHandoff,
        ),
      );
    }
  }
  let didDispatch = false;
  return async (channelId) => {
    if (didDispatch) {
      return;
    }
    if (opts.threadTs) {
      opts.assertDirectAdapterHandoff?.();
      // Slack may silently publish replies to deleted parents at channel level.
      // Check after queue/upload, once per send, not per chunk. A deletion between
      // this check and the write remains a Slack API race.
      await assertSlackReplyParent(clients, channelId, opts.threadTs);
    }
    didDispatch = true;
    await opts.onPlatformSendDispatch?.();
  };
}
