import type { WhatsAppConfig, IncomingWhatsAppMessage } from "./types.js";

export function whatsappWebhookHandler(opts: {
  config: WhatsAppConfig;
  handleIncoming: (m: IncomingWhatsAppMessage) => Promise<void> | void;
  logger?: Console;
}) {
  const { config, handleIncoming, logger = console } = opts;

  return async function handler(req: any, res: any) {
    try {
      if (req.method === "GET") {
        const mode = req.query?.["hub.mode"] ?? req.query?.mode ?? req.query?.hub?.mode;
        const challenge = req.query?.["hub.challenge"] ?? req.query?.challenge ?? req.query?.hub?.challenge;
        const token = req.query?.["hub.verify_token"] ?? req.query?.verify_token ?? req.query?.hub?.verify_token;

        if (token && token === config.verifyToken) {
          logger.log("WhatsApp webhook verification success");
          res.status(200).send(String(challenge ?? ""));
          return;
        }
        logger.warn("WhatsApp webhook verification failed");
        res.status(403).send("forbidden");
        return;
      }

      if (req.method === "POST") {
        const payload = req.body;
        logger.debug?.("WhatsApp webhook POST", { payload: typeof payload === "object" ? "[object]" : String(payload) });
        const entries = Array.isArray(payload?.entry) ? payload.entry : [];
        for (const entry of entries) {
          const changes = Array.isArray(entry?.changes) ? entry.changes : [];
          for (const change of changes) {
            const val = change?.value;
            const messages = Array.isArray(val?.messages) ? val.messages : [];
            for (const m of messages) {
              const from = m.from ?? m.sender?.id ?? "";
              const text = m.text?.body ?? m?.message?.text ?? undefined;
              const incoming = {
                id: m.id ?? m.message_id ?? (m?.wa_id ?? "unknown"),
                from,
                text,
                raw: m
              };
              try {
                await Promise.resolve(handleIncoming(incoming));
              } catch (err) {
                logger.error("Error in handleIncoming", err);
              }
            }
          }
        }
        res.status(200).send("EVENT_RECEIVED");
        return;
      }

      res.status(405).send("Method Not Allowed");
    } catch (err) {
      logger.error("WhatsApp webhook handler error", err);
      res.status(500).send("internal error");
    }
  };
}
