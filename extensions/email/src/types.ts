/**
 * Resolved email account configuration from openclaw.json.
 *
 * Config path: channels.email.accounts.<accountId>
 *
 * Example:
 * ```json
 * {
 *   "channels": {
 *     "email": {
 *       "accounts": {
 *         "default": {
 *           "enabled": true,
 *           "address": "brian@agent.americanclaw.ai",
 *           "outboundUrl": "https://americanclaw.ai/api/email/outbound",
 *           "outboundToken": "<gateway-token>"
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */
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

/**
 * Payload sent by American Claw's /api/email/inbound webhook
 * to the gateway RPC method "email.inbound".
 */
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

/**
 * Payload sent to American Claw's /api/email/outbound endpoint.
 */
export type EmailOutboundPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
};
