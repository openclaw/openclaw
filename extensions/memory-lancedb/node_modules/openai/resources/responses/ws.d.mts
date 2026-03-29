import * as WS from 'ws';
import { ResponsesEmitter, ResponsesStreamMessage } from "./internal-base.mjs";
import * as ResponsesAPI from "./responses.mjs";
import { OpenAI } from "../../client.mjs";
export declare class ResponsesWS extends ResponsesEmitter {
    url: URL;
    socket: WS.WebSocket;
    private client;
    constructor(client: OpenAI, options?: WS.ClientOptions | null | undefined);
    send(event: ResponsesAPI.ResponsesClientEvent): void;
    close(props?: {
        code: number;
        reason: string;
    }): void;
    /**
     * Returns an async iterator over WebSocket lifecycle and message events,
     * providing an alternative to the event-based `.on()` API.
     * The iterator will exit if the socket closes but breaking out of the iterator
     * does not close the socket.
     *
     * @example
     * ```ts
     * for await (const event of connection.stream()) {
     *   switch (event.type) {
     *     case 'message':
     *       console.log('received:', event.message);
     *       break;
     *     case 'error':
     *       console.error(event.error);
     *       break;
     *     case 'close':
     *       console.log('connection closed');
     *       break;
     *   }
     * }
     * ```
     */
    stream(): AsyncIterableIterator<ResponsesStreamMessage>;
    [Symbol.asyncIterator](): AsyncIterableIterator<ResponsesStreamMessage>;
    private authHeaders;
}
//# sourceMappingURL=ws.d.mts.map