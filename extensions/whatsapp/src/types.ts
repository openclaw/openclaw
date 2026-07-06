export type WhatsAppConfig = {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  businessAccountId?: string;
};

export type IncomingWhatsAppMessage = {
  id: string;
  from: string;
  text?: string;
  raw: unknown;
};
