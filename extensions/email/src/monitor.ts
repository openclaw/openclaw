import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { resolveEmailAccount } from "./accounts.js";
import {
  classifyImapError,
  computeBackoffSeconds,
  fetchUnseenMessages,
} from "./imap-client.js";
import { handleEmailInbound } from "./inbound.js";
import { getEmailRuntime } from "./runtime.js";
import type { CoreConfig, EmailInboundMessage } from "./types.js";
import type { RuntimeEnv } from "./runtime-api.js";

export type EmailMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

export async function monitorEmailProvider(
  opts: EmailMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getEmailRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveEmailAccount({ cfg, accountId: opts.accountId });

  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.configured) {
    throw new Error(
      `Email is not configured for account "${account.accountId}" (need imapHost, imapUsername, imapPassword in channels.email).`,
    );
  }

  if (!account.consentGranted) {
    runtime.log?.(
      `[${account.accountId}] Email channel not started: consentGranted is false.`,
    );
    return { stop: () => {} };
  }

  const logger = core.logging.getChildLogger({
    channel: "email",
    accountId: account.accountId,
  });

  let stopped = false;
  let authFailureCount = 0;
  let transientFailureCount = 0;
  const pollMs = Math.max(5, account.pollIntervalSeconds) * 1000;

  logger.info(
    `[${account.accountId}] starting email IMAP poller (${account.imapHost}:${account.imapPort}, mailbox=${account.imapMailbox}, interval=${account.pollIntervalSeconds}s)`,
  );

  const loop = async () => {
    while (!stopped && !opts.abortSignal?.aborted) {
      let sleepMs = pollMs;
      try {
        const messages = await fetchUnseenMessages(account);

        authFailureCount = 0;
        transientFailureCount = 0;

        if (messages.length > 0) {
          core.channel.activity.record({
            channel: "email",
            accountId: account.accountId,
            direction: "inbound",
            at: Date.now(),
          });
        }

        for (const msg of messages) {
          const inbound: EmailInboundMessage = {
            messageId: msg.messageId,
            uid: msg.uid,
            from: msg.from,
            subject: msg.subject,
            date: msg.date,
            inReplyTo: msg.inReplyTo,
            references: msg.references,
            text: msg.text,
            attachments: msg.attachments,
            timestamp: Date.now(),
          };

          await handleEmailInbound({
            message: inbound,
            account,
            config: cfg,
            runtime,
            statusSink: opts.statusSink,
          });
        }
      } catch (err) {
        if (opts.abortSignal?.aborted || stopped) break;

        const kind = classifyImapError(err);
        if (kind === "auth") {
          authFailureCount++;
          transientFailureCount = 0;
        } else {
          transientFailureCount++;
        }
        sleepMs =
          computeBackoffSeconds(kind, Math.max(authFailureCount, transientFailureCount), account.pollIntervalSeconds) *
          1000;
        logger.error(
          `[${account.accountId}] IMAP poll error (${kind}, backoff=${sleepMs / 1000}s): ${String(err)}`,
        );
      }

      try {
        await sleep(sleepMs, opts.abortSignal);
      } catch {
        break;
      }
    }
  };

  loop().catch((err) => {
    if (!stopped) {
      logger.error(`[${account.accountId}] email monitor loop crashed: ${String(err)}`);
    }
  });

  return {
    stop: () => {
      stopped = true;
    },
  };
}
