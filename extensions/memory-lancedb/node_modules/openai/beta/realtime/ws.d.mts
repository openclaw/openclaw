import * as WS from 'ws';
import { AzureOpenAI, OpenAI } from "../../index.mjs";
import type { RealtimeClientEvent } from "../../resources/beta/realtime/realtime.mjs";
import { OpenAIRealtimeEmitter } from "./internal-base.mjs";
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
//# sourceMappingURL=ws.d.mts.map