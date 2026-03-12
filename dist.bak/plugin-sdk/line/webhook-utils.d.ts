import type { WebhookRequestBody } from "@line/bot-sdk";
export declare function parseLineWebhookBody(rawBody: string): WebhookRequestBody | null;
export declare function isLineWebhookVerificationRequest(body: WebhookRequestBody | null | undefined): boolean;
