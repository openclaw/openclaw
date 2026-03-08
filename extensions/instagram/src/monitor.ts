import path from "node:path";
import { createLoggerBackedRuntime, readJsonFileWithFallback, writeJsonFileAtomically, type RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveInstagramAccount } from "./accounts.js";
import { listInstagramMessages, listInstagramThreads, markInstagramThreadRead } from "./client.js";
import { handleInstagramInbound } from "./inbound.js";
import { getInstagramRuntime } from "./runtime.js";
import type { CoreConfig, InstagramInboundMessage, InstagramPollState } from "./types.js";

export type InstagramMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastPollAt?: number;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string | null;
  }) => void;
};

function resolveStateFile(accountId: string): string {
  const stateDir = getInstagramRuntime().state.resolveStateDir(process.env);
  return path.join(stateDir, "instagram", `${accountId}.json`);
}

async function waitForDelay(ms: number, signal?: AbortSignal) {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function monitorInstagramProvider(
  opts: InstagramMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getInstagramRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveInstagramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime =
    opts.runtime ??
    createLoggerBackedRuntime({
      logger: core.logging.getChildLogger(),
      exitError: () => new Error("Runtime exit not available"),
    });

  if (!account.configured) {
    throw new Error(`Instagram is not configured for account "${account.accountId}".`);
  }

  const logger = core.logging.getChildLogger({
    channel: "instagram",
    accountId: account.accountId,
  });
  const stateFile = resolveStateFile(account.accountId);
  let stopped = false;

  const loop = async () => {
    const { value: state } = await readJsonFileWithFallback<InstagramPollState>(stateFile, {
      threads: {},
    });
    while (!stopped && !opts.abortSignal?.aborted) {
      try {
        const threads = await listInstagramThreads(account, { limit: 100 });
        const now = Date.now();
        opts.statusSink?.({ lastPollAt: now, lastError: null });

        for (const thread of threads) {
          const threadState = state.threads[thread.id] ?? {};
          const { messages } = await listInstagramMessages(account, {
            threadId: thread.id,
            limit: 50,
            since: threadState.lastTimestamp,
          });
          const ordered = messages
            .filter((message) => !message.isOutgoing)
            .filter((message) => message.itemType === "text")
            .filter((message) => message.text?.trim())
            .sort((a, b) => {
              const left = a.timestamp ? new Date(a.timestamp).getTime() : 0;
              const right = b.timestamp ? new Date(b.timestamp).getTime() : 0;
              return left - right;
            });

          let latestId = threadState.lastMessageId;
          let latestTimestamp = threadState.lastTimestamp;
          for (const entry of ordered) {
            if (entry.id === threadState.lastMessageId) {
              continue;
            }
            const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
            const inbound: InstagramInboundMessage = {
              messageId: entry.id,
              threadId: thread.id,
              target: thread.id,
              senderUsername: entry.username ?? "",
              text: entry.text?.trim() ?? "",
              timestamp,
              isGroup: thread.usernames.length > 1,
              usernames: thread.usernames,
              title: thread.title,
            };
            core.channel.activity.record({
              channel: "instagram",
              accountId: account.accountId,
              direction: "inbound",
              at: timestamp,
            });
            await handleInstagramInbound({
              message: inbound,
              account,
              config: cfg,
              runtime,
              statusSink: opts.statusSink,
            });
            opts.statusSink?.({ lastInboundAt: timestamp });
            latestId = entry.id;
            latestTimestamp = entry.timestamp ?? latestTimestamp;
          }

          if (latestId) {
            state.threads[thread.id] = {
              lastMessageId: latestId,
              lastTimestamp: latestTimestamp,
              lastProcessedAt: now,
            };
            if (thread.unread) {
              await markInstagramThreadRead(account, thread.id, latestId).catch((error) => {
                logger.warn(`[${account.accountId}] failed to mark thread ${thread.id} read: ${String(error)}`);
              });
            }
          }
        }

        state.lastPollAt = now;
        await writeJsonFileAtomically(stateFile, state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[${account.accountId}] Instagram monitor error: ${message}`);
        opts.statusSink?.({ lastError: message });
      }
      await waitForDelay(account.config.pollIntervalMs ?? 30_000, opts.abortSignal);
    }
  };

  void loop();

  return {
    stop: () => {
      stopped = true;
    },
  };
}
