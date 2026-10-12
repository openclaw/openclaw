import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { registerNextcloudTalkWebhook } from "./monitor.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";
import {
  DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH,
  describeNextcloudTalkWebhookRouteConflict,
  resolveNextcloudTalkLegacyWebhook,
} from "./webhook-route.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

function normalizeOrigin(value: string): string | null {
  return URL.parse(value)?.origin.toLowerCase() ?? null;
}

type NextcloudTalkMonitorOptions = {
  accountId?: string;
  config: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
};

export async function monitorNextcloudTalkProvider(
  opts: NextcloudTalkMonitorOptions,
): Promise<{ stop: () => Promise<void> }> {
  const core = getNextcloudTalkRuntime();
  const cfg = opts.config;
  const account = resolveNextcloudTalkAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.secret) {
    throw new Error(`Nextcloud Talk bot secret not configured for account "${account.accountId}"`);
  }

  const path = account.config.webhookPath ?? DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH;
  const gatewayPort = resolveGatewayPort({ gateway: cfg.gateway });
  const legacyListener = resolveNextcloudTalkLegacyWebhook(account.config);
  const routeConflict = describeNextcloudTalkWebhookRouteConflict(path, gatewayPort);
  if (routeConflict && !legacyListener) {
    throw new Error(`[nextcloud-talk:${account.accountId}] ${routeConflict}`);
  }

  const logger = core.logging.getChildLogger({
    channel: "nextcloud-talk",
    accountId: account.accountId,
  });
  const expectedBackendOrigin = normalizeOrigin(account.baseUrl);
  const spool = createNextcloudTalkWebhookSpool({
    accountId: account.accountId,
    runtime,
    abortSignal: opts.abortSignal,
    deliver: async (message, lifecycle) => {
      core.channel.activity.record({
        channel: "nextcloud-talk",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });
      await handleNextcloudTalkInbound({
        message,
        account,
        config: cfg,
        runtime,
        statusSink: opts.statusSink,
        turnAdoptionLifecycle: lifecycle,
      });
    },
  });

  let unregister: (() => Promise<void>) | undefined;
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= (async () => {
      await unregister?.();
      unregister = undefined;
      await spool.stop();
    })();
    return stopPromise;
  };

  if (opts.abortSignal && !opts.abortSignal.aborted) {
    opts.abortSignal.addEventListener("abort", () => void stop(), { once: true });
  }

  if (opts.abortSignal?.aborted) {
    await stop();
    return { stop };
  }
  try {
    await spool.ready();
    if (opts.abortSignal?.aborted) {
      await stop();
      return { stop };
    }
    unregister = registerNextcloudTalkWebhook({
      accountId: account.accountId,
      legacyListener,
      path,
      secret: account.secret,
      isBackendAllowed: (backend) => {
        if (!expectedBackendOrigin) {
          return true;
        }
        const backendOrigin = normalizeOrigin(backend);
        return backendOrigin === expectedBackendOrigin;
      },
      onWebhook: spool.receive,
      onError: (error) => {
        logger.error(`[nextcloud-talk:${account.accountId}] webhook error: ${error.message}`);
      },
      trustedProxies: cfg.gateway?.trustedProxies,
      allowRealIpFallback: cfg.gateway?.allowRealIpFallback,
    });
  } catch (error) {
    await stop();
    throw error;
  }
  if (opts.abortSignal?.aborted) {
    await stop();
    return { stop };
  }
  opts.statusSink?.(channelReadyPatch());

  if (routeConflict && legacyListener) {
    logger.warn(
      `[nextcloud-talk:${account.accountId}] ${routeConflict} ` +
        `Legacy webhook listener ${legacyListener.host}:${legacyListener.port} remains available; verify the new route before removing the legacyWebhook pin.`,
    );
    return { stop };
  }
  logger.info(
    `[nextcloud-talk:${account.accountId}] Gateway webhook route ready at port ${gatewayPort}${path}; ` +
      "point the Nextcloud bot callback or reverse-proxy upstream here.",
  );
  if (legacyListener) {
    logger.info(
      `[nextcloud-talk:${account.accountId}] legacy webhook listener ${legacyListener.host}:${legacyListener.port} forwards to the Gateway route. ` +
        "After verifying the callback or proxy upstream uses the Gateway port, remove the legacyWebhook pin; use legacyWebhook: false to override an inherited endpoint.",
    );
  }

  return { stop };
}
