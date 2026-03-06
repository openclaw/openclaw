import type { WebhookRequestBody } from "@line/bot-sdk";
import type { Request, Response, NextFunction } from "express";
import type { RuntimeEnv } from "../runtime.js";
export interface LineWebhookOptions {
    channelSecret: string;
    onEvents: (body: WebhookRequestBody) => Promise<void>;
    runtime?: RuntimeEnv;
}
export declare function createLineWebhookMiddleware(options: LineWebhookOptions): (req: Request, res: Response, _next: NextFunction) => Promise<void>;
export interface StartLineWebhookOptions {
    channelSecret: string;
    onEvents: (body: WebhookRequestBody) => Promise<void>;
    runtime?: RuntimeEnv;
    path?: string;
}
export declare function startLineWebhook(options: StartLineWebhookOptions): {
    path: string;
    handler: (req: Request, res: Response, _next: NextFunction) => Promise<void>;
};
