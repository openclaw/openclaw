import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebhookRequestBody } from "@line/bot-sdk";
import type { RuntimeEnv } from "../runtime.js";
export declare function readLineWebhookRequestBody(req: IncomingMessage, maxBytes?: number): Promise<string>;
type ReadBodyFn = (req: IncomingMessage, maxBytes: number) => Promise<string>;
export declare function createLineNodeWebhookHandler(params: {
    channelSecret: string;
    bot: {
        handleWebhook: (body: WebhookRequestBody) => Promise<void>;
    };
    runtime: RuntimeEnv;
    readBody?: ReadBodyFn;
    maxBodyBytes?: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export {};
