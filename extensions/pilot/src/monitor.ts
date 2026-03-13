import { createLoggerBackedRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/pilot";
import { resolvePilotAccount } from "./accounts.js";
import { handlePilotInbound } from "./inbound.js";
import * as pilotctl from "./pilotctl.js";
import { getPilotRuntime } from "./runtime.js";
import type { CoreConfig, PilotInboundMessage } from "./types.js";

export type PilotMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  onMessage?: (message: PilotInboundMessage) => void | Promise<void>;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function monitorPilotProvider(
  opts: PilotMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getPilotRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolvePilotAccount({
    cfg,
    accountId: opts.accountId,
  });

  const runtime: RuntimeEnv =
    opts.runtime ??
    createLoggerBackedRuntime({
      logger: core.logging.getChildLogger(),
      exitError: () => new Error("Runtime exit not available"),
    });

  if (!account.configured) {
    throw new Error(
      `Pilot is not configured for account "${account.accountId}" (need hostname in channels.pilot).`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "pilot",
    accountId: account.accountId,
  });

  const pilotctlOpts = {
    socketPath: account.socketPath,
    pilotctlPath: account.pilotctlPath,
  };

  // Ensure daemon is running with the correct identity and registry.
  let needsStart = false;
  try {
    const status = await pilotctl.daemonStatus(pilotctlOpts);
    if (!status.running) {
      needsStart = true;
    } else if (status.hostname && status.hostname !== account.hostname) {
      throw new Error(
        `Pilot daemon on ${account.socketPath} is running as "${status.hostname}" but account "${account.accountId}" expects "${account.hostname}". ` +
          "Stop the existing daemon or use a different socketPath.",
      );
    } else if (status.registry && account.registry && status.registry !== account.registry) {
      throw new Error(
        `Pilot daemon on ${account.socketPath} is connected to registry "${status.registry}" but account "${account.accountId}" expects "${account.registry}". ` +
          "Stop the existing daemon or use a different socketPath.",
      );
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("expects") || err.message.includes("connected to registry"))
    ) {
      throw err;
    }
    // Status call itself failed — daemon likely not running.
    needsStart = true;
  }

  if (needsStart) {
    logger.info(`[${account.accountId}] starting daemon...`);
    await pilotctl.daemonStart(account.hostname, account.registry, pilotctlOpts);
  }

  logger.info(
    `[${account.accountId}] connected to Pilot network as ${account.hostname} (polling every ${account.pollIntervalMs}ms)`,
  );

  let stopped = false;
  const abortController = new AbortController();

  // Link external abort signal.
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener(
      "abort",
      () => {
        stopped = true;
        abortController.abort(opts.abortSignal?.reason);
      },
      { once: true },
    );
  }

  // Polling loop.
  const poll = async () => {
    while (!stopped && !abortController.signal.aborted) {
      try {
        const messages = await pilotctl.receiveMessages(pilotctlOpts);
        for (const message of messages) {
          try {
            core.channel.activity.record({
              channel: "pilot",
              accountId: account.accountId,
              direction: "inbound",
              at: message.timestamp,
            });

            if (opts.onMessage) {
              await opts.onMessage(message);
              continue;
            }

            await handlePilotInbound({
              message,
              account,
              config: cfg,
              runtime,
              statusSink: opts.statusSink,
            });
          } catch (msgErr) {
            logger.error(
              `[${account.accountId}] failed processing message from ${message.sender}: ${String(msgErr)}`,
            );
          }
        }
      } catch (err) {
        if (!stopped) {
          logger.error(`[${account.accountId}] poll error: ${String(err)}`);
        }
      }

      try {
        await sleep(account.pollIntervalMs, abortController.signal);
      } catch {
        break;
      }
    }
  };

  // Start polling in background; capture the promise so stop() can await it.
  const pollDone = poll().catch((err) => {
    if (!stopped) {
      logger.error(`[${account.accountId}] monitor loop exited: ${String(err)}`);
    }
  });

  return {
    stop: () => {
      stopped = true;
      abortController.abort(new Error("shutdown"));
      return pollDone;
    },
  };
}
