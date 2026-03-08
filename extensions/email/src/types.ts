export type EmailAccountConfig = {
  enabled?: boolean;
  name?: string;
  address?: string;
  outboundUrl?: string;
  outboundToken?: string;
  dmPolicy?: "open" | "pairing" | "closed";
  allowFrom?: Array<string | number>;
};

export type ResolvedEmailAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  address: string;
  outboundUrl: string;
  outboundToken: string;
  dmPolicy: "open" | "pairing" | "closed";
  allowFrom: Array<string | number>;
};

export type EmailInboundPayload = {
  from: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: {
    messageId?: string;
    [key: string]: unknown;
  };
};

export type EmailOutboundPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
};
