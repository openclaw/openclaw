import type { IncomingMessage, ServerResponse } from "node:http";
export { normalizeSlackWebhookPath } from "./paths.js";
export type SlackHttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
type RegisterSlackHttpHandlerArgs = {
    path?: string | null;
    handler: SlackHttpRequestHandler;
    log?: (message: string) => void;
    accountId?: string;
};
export declare function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void;
export declare function handleSlackHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
