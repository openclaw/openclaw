// Line plugin module implements bot behavior.
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  createNonExitingRuntime,
  logVerbose,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { resolveLineAccount } from "./accounts.js";
import { createLineWebhookReplayCache, handleLineWebhookEvents } from "./bot-handlers.js";
import type { LineInboundContext } from "./bot-message-context.js";
import type { ResolvedLineAccount } from "./types.js";
import type { LineWebhookDispatchCallbacks } from "./webhook-ack.js";

interface LineBotOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  config?: OpenClawConfig;
  mediaMaxMb?: number;
  onMessage?: (ctx: LineInboundContext) => Promise<void>;
}

interface LineBot {
  handleWebhook: (
    body: webhook.CallbackRequest,
    callbacks?: LineWebhookDispatchCallbacks,
  ) => Promise<void>;
  account: ResolvedLineAccount;
}

export function createLineBot(opts: LineBotOptions): LineBot {
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const cfg = opts.config ?? getRuntimeConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });

  const mediaMaxBytes = (opts.mediaMaxMb ?? account.config.mediaMaxMb ?? 10) * 1024 * 1024;

  const processMessage =
    opts.onMessage ??
    (async () => {
      logVerbose("line: no message handler configured");
    });
  const replayCache = createLineWebhookReplayCache();
  const groupHistories = new Map<string, HistoryEntry[]>();
  const conversationAcceptanceTails = new Map<string, Promise<void>>();

  const handleWebhook = async (
    body: webhook.CallbackRequest,
    callbacks?: LineWebhookDispatchCallbacks,
  ): Promise<void> => {
    if (!body.events || body.events.length === 0) {
      return;
    }

    await handleLineWebhookEvents(body.events, {
      cfg,
      account,
      runtime,
      mediaMaxBytes,
      processMessage,
      replayCache,
      groupHistories,
      conversationAcceptanceTails,
      historyLimit: cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
      onEventAccepted: callbacks?.onEventAccepted,
    });
  };

  return {
    handleWebhook,
    account,
  };
}
