/** Normalized HTTP response produced by provider webhook parsing or replay handling. */
export type WebhookResponsePayload = {
  /** HTTP status returned to the carrier webhook request. */
  statusCode: number;
  /** Response body; XML for telephony providers, plain text for generic failures. */
  body: string;
  /** Optional carrier-specific headers such as TwiML/XML content type. */
  headers?: Record<string, string>;
};
