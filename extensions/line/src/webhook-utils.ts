import type { WebhookRequestBody } from "@line/bot-sdk";
export { validateLineSignature } from "./signature.js";

export function parseLineWebhookBody(rawBody: string): WebhookRequestBody | null {
  try {
    return JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    return null;
  }
}
