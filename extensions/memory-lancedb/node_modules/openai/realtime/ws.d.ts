import * as WS from 'ws';
import { AzureOpenAI, OpenAI } from "../index.js";
import type { RealtimeClientEvent } from "../resources/realtime/realtime.js";
import { OpenAIRealtimeEmitter } from "./internal-base.js";
export declare class OpenAIRealtimeWS extends OpenAIRealtimeEmitter {
    url: URL;
    socket: WS.WebSocket;
    constructor(props: {
        model: string;
        options?: WS.ClientOptions | undefined;
        /** @internal */ __resolvedApiKey?: boolean;
    }, client?: Pick<OpenAI, 'apiKey' | 'baseURL'>);
    static create(client: Pick<OpenAI, 'apiKey' | 'baseURL' | '_callApiKey'>, props: {
        model: string;
        options?: WS.ClientOptions | undefined;
    }): Promise<OpenAIRealtimeWS>;
    static azure(client: Pick<AzureOpenAI, '_callApiKey' | 'apiVersion' | 'apiKey' | 'baseURL' | 'deploymentName'>, props?: {
        deploymentName?: string;
        options?: WS.ClientOptions | undefined;
    }): Promise<OpenAIRealtimeWS>;
    send(event: RealtimeClientEvent): void;
    close(props?: {
        code: number;
        reason: string;
    }): void;
}
//# sourceMappingURL=ws.d.ts.map