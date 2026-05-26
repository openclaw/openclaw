import { type RequestListener } from "node:http";
export declare function withServer(handler: RequestListener, fn: (baseUrl: string) => Promise<void>): Promise<void>;
