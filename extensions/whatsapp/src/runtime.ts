import { whatsappWebhookHandler } from "./webhook.js";
import { WhatsAppService } from "./service.js";
import { mapWhatsAppToInbound } from "./adapter.js";

export function registerWhatsAppRuntime(hostRuntime: any, logger = console) {
  const env = process.env;
  const cfg = {
    accessToken: env.WHATSAPP_ACCESS_TOKEN ?? "",
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "",
    businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID
  };

  if (!cfg.accessToken || !cfg.phoneNumberId || !cfg.verifyToken) {
    logger.error("WhatsApp extension: missing required envs. Please set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_WEBHOOK_VERIFY_TOKEN");
    return;
  }

  const service = new WhatsAppService({ accessToken: cfg.accessToken, phoneNumberId: cfg.phoneNumberId, logger });

  const app = hostRuntime?.http?.app ?? hostRuntime?.app ?? hostRuntime?.serverApp;
  if (!app || typeof app.use !== "function") {
    logger.warn("WhatsApp extension: host runtime does not expose http.app; cannot register /webhook/whatsapp automatically.");
    return;
  }

  const handleIncoming = async (m: any) => {
    const inbound = mapWhatsAppToInbound(m);
    try {
      if (typeof hostRuntime?.dispatcher?.handleInbound === "function") {
        await hostRuntime.dispatcher.handleInbound(inbound);
        return;
      }
      if (typeof hostRuntime?.channel?.handleInbound === "function") {
        await hostRuntime.channel.handleInbound(inbound);
        return;
      }
      if (typeof hostRuntime?.emit === "function") {
        hostRuntime.emit("inbound-message", inbound);
        return;
      }
      logger.warn("WhatsApp extension: no inbound handler found on runtime; inbound message dropped", inbound);
    } catch (err) {
      logger.error("WhatsApp extension dispatch error", err);
    }
  };

  app.use("/webhook/whatsapp", whatsappWebhookHandler({ config: cfg, handleIncoming, logger }));

  hostRuntime.whatsappService = service;

  logger.info("WhatsApp extension registered at /webhook/whatsapp");
}
