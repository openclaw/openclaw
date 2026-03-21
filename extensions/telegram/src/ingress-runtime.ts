import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { runChannelIngressMiddlewares } from "../../../src/channels/ingress/runtime.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { TelegramAccountConfig } from "../../../src/config/types.telegram.js";
import { buildTelegramMessageContext } from "./bot-message-context.js";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.js";
import { sendMessageTelegram } from "./send.js";

export type TelegramMessageContext = NonNullable<
  Awaited<ReturnType<typeof buildTelegramMessageContext>>
>;

export async function runTelegramIngressMiddlewares(params: {
  context: TelegramMessageContext;
  cfg: OpenClawConfig;
  account: BuildTelegramMessageContextParams["account"];
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
}) {
  const { context, cfg, account, telegramCfg, runtime } = params;
  const routeAgentId = String(context.route?.agentId ?? "");
  const sessionKey = String(context.route?.sessionKey ?? context.ctxPayload?.SessionKey ?? "");
  const senderId = context.msg?.from?.id != null ? String(context.msg.from.id) : "";
  runtime.log(
    `ingress-runtime enter agent=${routeAgentId || "-"} session=${sessionKey || "-"} sender=${senderId || "-"} group=${String(Boolean(context.isGroup))}`,
  );
  const result = await runChannelIngressMiddlewares({
    entries: telegramCfg.ingressMiddlewares,
    args: {
      context,
      sendTelegram: async (to: string, text: string) => {
        await sendMessageTelegram(to, text, { cfg, accountId: account.accountId });
      },
      logger: runtime,
    },
    logger: runtime,
  });
  const notifiedCount = result.outcomes.filter(
    (entry) =>
      entry.result &&
      typeof entry.result === "object" &&
      "notified" in (entry.result as Record<string, unknown>) &&
      (entry.result as { notified?: unknown }).notified === true,
  ).length;
  runtime.log(
    `ingress-runtime done middlewares=${String(result.middlewareCount)} notified=${String(notifiedCount)} session=${sessionKey || "-"}`,
  );
  return result;
}

export async function maybeRunTelegramIngressMiddlewares(params: {
  context: TelegramMessageContext;
  cfg: OpenClawConfig;
  account: BuildTelegramMessageContextParams["account"];
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
}) {
  if (!params.telegramCfg.ingressMiddlewares?.length) {
    return { middlewareCount: 0, outcomes: [] };
  }
  try {
    return await runTelegramIngressMiddlewares(params);
  } catch (err) {
    params.runtime.error(danger(`ingress-runtime failed: ${String(err)}`));
    return { middlewareCount: 0, outcomes: [] };
  }
}
