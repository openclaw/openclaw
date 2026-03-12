import { createLoggerBackedRuntime, type RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveWechatAccount } from "./accounts.js";
import { handleWechatInbound } from "./inbound.js";
import { getWechatRuntime } from "./runtime.js";
import { registerWechatBot, unregisterWechatBot } from "./send.js";
import type { CoreConfig, WechatInboundMessage } from "./types.js";

export type WechatMonitorOptions = {
  accountId: string;
  config: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Record<string, unknown>) => void;
};

/** Start monitoring WeChat messages via Wechaty. */
export async function monitorWechatProvider(
  opts: WechatMonitorOptions,
): Promise<{ stop: () => void }> {
  const { accountId, config, abortSignal, statusSink } = opts;
  const core = getWechatRuntime();
  const account = resolveWechatAccount({ cfg: config, accountId });

  if (!account.configured) {
    throw new Error(`WeChat is not configured for account "${accountId}".`);
  }

  const runtime: RuntimeEnv =
    opts.runtime ??
    createLoggerBackedRuntime({
      logger: core.logging.getChildLogger(),
      exitError: () => new Error("Runtime exit not available"),
    });

  // Dynamic import to avoid requiring wechaty at module load time
  const { WechatyBuilder } = await import("wechaty");

  runtime.log(`[${accountId}] creating Wechaty bot (puppet: ${account.puppet})`);

  const botOptions: Record<string, unknown> = {
    name: `openclaw-wechat-${accountId}`,
  };

  // Only set puppet if it's not the default (let Wechaty auto-detect)
  if (account.puppet && account.puppet !== "wechaty-puppet-wechat4") {
    botOptions.puppet = account.puppet;
    if (Object.keys(account.puppetOptions).length > 0) {
      botOptions.puppetOptions = account.puppetOptions;
    }
  }

  const bot = WechatyBuilder.build(botOptions);

  bot.on("scan", (qrcode: string, status: number) => {
    runtime.log(`[${accountId}] scan QR code to login (status: ${status})`);
    statusSink?.({ qrcode: `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}` });
  });

  bot.on("login", (user: { name: () => string }) => {
    runtime.log(`[${accountId}] logged in as ${user.name()}`);
    registerWechatBot(accountId, bot);
    statusSink?.({ running: true, lastStartAt: Date.now(), lastError: null, qrcode: null });
  });

  bot.on("logout", (user: { name: () => string }) => {
    runtime.log(`[${accountId}] logged out: ${user.name()}`);
    unregisterWechatBot(accountId);
    statusSink?.({ running: false, lastStopAt: Date.now() });
  });

  bot.on("error", (error: Error) => {
    runtime.error(`[${accountId}] error: ${error.message}`);
    statusSink?.({ lastError: error.message });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wechaty message type is complex
  bot.on("message", async (msg: any) => {
    try {
      if (msg.self()) {
        return;
      }

      const msgType = msg.type();
      // Only handle text messages (type 7 = Text in Wechaty)
      if (msgType !== 7) {
        return;
      }

      const text = msg.text()?.trim();
      if (!text) {
        return;
      }

      const room = msg.room();
      const talker = msg.talker();
      const isGroup = Boolean(room);
      const senderId = talker?.id ?? "";
      const senderName = talker?.name() ?? undefined;
      const roomTopic = room ? await room.topic() : undefined;
      const roomId = room?.id;

      const message: WechatInboundMessage = {
        messageId: msg.id ?? `wechat_${Date.now()}`,
        text,
        senderId,
        senderName,
        roomId,
        roomTopic,
        isGroup,
        timestamp: msg.date()?.getTime() ?? Date.now(),
        target: isGroup ? (roomId ?? "") : senderId,
      };

      core.channel.activity.record({
        channel: "wechat",
        accountId: account.accountId,
        direction: "inbound",
      });
      statusSink?.({ lastInboundAt: message.timestamp });

      await handleWechatInbound({
        message,
        account,
        config,
        runtime,
        statusSink: statusSink as
          | ((patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void)
          | undefined,
      });
    } catch (err) {
      runtime.error(`[${accountId}] message handler error: ${String(err)}`);
    }
  });

  await bot.start();
  runtime.log(`[${accountId}] Wechaty bot started, waiting for QR scan`);

  function stop() {
    unregisterWechatBot(accountId);
    bot.stop().catch((err: Error) => {
      runtime.error(`[${accountId}] stop error: ${err.message}`);
    });
    statusSink?.({ running: false, lastStopAt: Date.now() });
  }

  abortSignal?.addEventListener("abort", stop, { once: true });

  return { stop };
}
