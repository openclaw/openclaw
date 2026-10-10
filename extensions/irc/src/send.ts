import { randomUUID } from "node:crypto";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { convertMarkdownTables, stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import { resolveIrcAccount } from "./accounts.js";
import type { IrcClient } from "./client.js";
import { connectIrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import { normalizeIrcMessagingTarget } from "./normalize.js";
import { getOptionalIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type SendIrcOptions = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
  client?: IrcClient;
  abortSignal?: AbortSignal;
  onPlatformSendDispatch?: () => Promise<void>;
};

type SendIrcMessage = {
  text: string;
  replyTo?: string;
};

export type SendIrcResult = {
  messageId: string;
  target: string;
  receipt: MessageReceipt;
};

export async function sendIrcMessages(
  to: string,
  text: string,
  opts: SendIrcOptions,
  planMessages: (preparedText: string) => readonly SendIrcMessage[] = (preparedText) => [
    { text: preparedText, replyTo: opts.replyTo },
  ],
  onDeliveryResult?: (result: SendIrcResult) => Promise<void> | void,
): Promise<SendIrcResult[]> {
  const effect = captureEffectAuthority();
  const cfg = requireRuntimeConfig(opts.cfg, "IRC send") as CoreConfig;
  const account = resolveIrcAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
    );
  }

  const target = normalizeIrcMessagingTarget(to);
  if (!target) {
    throw new Error(`Invalid IRC target: ${to}`);
  }
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "irc",
    accountId: account.accountId,
  });
  if (!text) {
    return [];
  }
  // Render the complete source before splitting: fragment parsing loses code,
  // link, and table context and can turn a closing fence into an empty message.
  const prepared = stripMarkdown(convertMarkdownTables(text.trim(), tableMode));
  if (!prepared.trim()) {
    throw new Error("Message must be non-empty for IRC sends");
  }
  const messages = planMessages(prepared);
  opts.abortSignal?.throwIfAborted();

  let transient: IrcClient | undefined;
  const client = opts.client?.isReady()
    ? opts.client
    : (transient = await connectIrcClient(
        buildIrcConnectOptions(account, {
          connectTimeoutMs: 12000,
          abortSignal: opts.abortSignal,
        }),
      ));

  const results: SendIrcResult[] = [];
  try {
    opts.abortSignal?.throwIfAborted();
    if (transient && (target.startsWith("#") || target.startsWith("&"))) {
      await effect.initiate(() => {
        opts.abortSignal?.throwIfAborted();
        if (!client.isReady()) {
          throw new Error("IRC connection closed before join");
        }
        client.join(target);
      });
    }
    for (const message of messages) {
      opts.abortSignal?.throwIfAborted();
      if (!client.isReady()) {
        throw new Error("IRC connection closed before send");
      }
      await opts.onPlatformSendDispatch?.();
      opts.abortSignal?.throwIfAborted();
      if (!client.isReady()) {
        throw new Error("IRC connection closed before send");
      }
      await client.sendPrivmsg(target, message.text, message.replyTo);
      const messageId = randomUUID();
      const result = {
        messageId,
        target,
        receipt: createMessageReceiptFromOutboundResults({
          results: [
            {
              channel: "irc",
              messageId,
              conversationId: target,
            },
          ],
          kind: "text",
          ...(message.replyTo ? { replyToId: message.replyTo } : {}),
        }),
      };
      results.push(result);
      getOptionalIrcRuntime()?.channel.activity.record({
        channel: "irc",
        accountId: account.accountId,
        direction: "outbound",
      });
      await onDeliveryResult?.(result);
    }
    return results;
  } catch (error) {
    if (results.length === 0) {
      throw error;
    }
    const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        ...results.map((result) => ({ receipt: result.receipt })),
        ...(partial?.receipt ? [{ receipt: partial.receipt }] : []),
        ...(partial?.messageIds ?? [])
          .filter((messageId) => !partial?.receipt?.platformMessageIds.includes(messageId))
          .map((messageId) => ({ channel: "irc", messageId, conversationId: target })),
      ],
      kind: "text",
    });
    throw createChannelPartialDeliveryError(error, {
      ...partial,
      messageIds: receipt.platformMessageIds,
      receipt,
      visibleReplySent: true,
    });
  } finally {
    transient?.quit("sent");
  }
}

export async function sendMessageIrc(
  to: string,
  text: string,
  opts: SendIrcOptions,
): Promise<SendIrcResult> {
  const result = (await sendIrcMessages(to, text, opts))[0];
  if (!result) {
    throw new Error("Message must be non-empty for IRC sends");
  }
  return result;
}
