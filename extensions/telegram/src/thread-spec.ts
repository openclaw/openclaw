export type TelegramThreadSpec = {
  id?: number;
  /** dm is the historical bot-private topic scope. */
  scope: "direct-messages" | "dm" | "forum" | "none";
};
