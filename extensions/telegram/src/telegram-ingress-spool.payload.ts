import type { PreparedTelegramPollAnswer } from "./poll-answer-context.js";
import type { PreparedTelegramWidgetQuery } from "./widgets/widget-query-context.js";

export type TelegramSpooledUpdatePayload = {
  version: number;
  updateId: number;
  receivedAt: number;
  update: unknown;
  preparedPollAnswer?: PreparedTelegramPollAnswer;
  /** Topic of the tapped widget, resolved at admission so replays keep the same lane. */
  preparedWidgetQuery?: PreparedTelegramWidgetQuery;
};

export const TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION = 1;

export class TelegramIngressPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TelegramIngressPayloadError";
  }
}
