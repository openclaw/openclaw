import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveLineAccount } from "./accounts.js";
import { handleLineWebhookEvents } from "./bot-handlers.js";
import { createLineWebhookSpool } from "./webhook-spool.js";

const DEFAULT_MEDIA_MAX_MB = 10;
type BuildChannelInboundContext =
  typeof import("openclaw/plugin-sdk/channel-inbound").buildChannelInboundEventContext;

interface LineBotOptions {
  accountId?: string;
  runtime: RuntimeEnv;
  buildContext?: BuildChannelInboundContext;
  config: OpenClawConfig;
  onMessage: Parameters<typeof handleLineWebhookEvents>[1]["processMessage"];
}

export function createLineBot(opts: LineBotOptions) {
  const { runtime, config: startupConfig } = opts;
  // LINE monitors outlive reloads outside `channels.line`. Bind snapshot ownership
  // once at startup; checking after reload would compare against the replaced source
  // and pin a process-owned monitor to stale config.
  const startupRuntimeConfig = getRuntimeConfigSnapshot();
  const startupRuntimeSourceConfig = getRuntimeConfigSourceSnapshot();
  // A snapshot without its source cannot prove that a distinct supplied config is
  // process-owned, so keep scoped monitors pinned through later global reloads.
  const followsRuntimeConfig =
    startupRuntimeConfig === startupConfig ||
    (startupRuntimeSourceConfig !== null &&
      selectApplicableRuntimeConfig({
        inputConfig: startupConfig,
        runtimeConfig: startupRuntimeConfig,
        runtimeSourceConfig: startupRuntimeSourceConfig,
      }) === startupRuntimeConfig);
  const resolveTurnConfig = (): OpenClawConfig =>
    (followsRuntimeConfig ? getRuntimeConfigSnapshot() : undefined) ?? startupConfig;
  // `channels.line` changes restart the monitor, so account credentials and settings
  // remain startup-prepared facts.
  const account = resolveLineAccount({
    cfg: startupConfig,
    accountId: opts.accountId,
  });

  // A non-positive cap cannot bound a transfer, so treat it as unset at every
  // link. `??` alone keeps a configured 0 or negative and turns every inbound
  // media download into a 0-byte budget the media core rejects, which degrades
  // the attachment to an unavailable notice without naming the setting.
  const configuredMediaMaxMb = account.config.mediaMaxMb;
  const effectiveMediaMaxMb =
    typeof configuredMediaMaxMb === "number" && configuredMediaMaxMb > 0
      ? configuredMediaMaxMb
      : DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = effectiveMediaMaxMb * 1024 * 1024;

  const groupHistories = new Map<string, HistoryEntry[]>();
  const spool = createLineWebhookSpool({
    accountId: account.accountId,
    runtime,
    deliver: async (events, _destination, control) => {
      const cfg = resolveTurnConfig();
      await handleLineWebhookEvents([...events], {
        cfg,
        account,
        runtime,
        buildContext: opts.buildContext,
        mediaMaxBytes,
        processMessage: opts.onMessage,
        ...(control.turnAdoptionLifecycle
          ? { turnAdoptionLifecycle: control.turnAdoptionLifecycle }
          : {}),
        ...(control.missingParts === undefined ? {} : { missingParts: control.missingParts }),
        groupHistories,
        historyLimit: resolvePromptHistoryLimit(
          account.config.historyLimit ?? cfg.messages?.groupChat?.historyLimit,
        ),
      });
    },
  });
  spool.start();

  return {
    handleWebhook: spool.accept,
    account,
    stop: spool.stop,
  };
}
