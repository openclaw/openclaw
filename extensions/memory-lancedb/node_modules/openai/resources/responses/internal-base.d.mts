import * as ResponsesAPI from "./responses.mjs";
import { OpenAI } from "../../client.mjs";
import { EventEmitter } from "../../core/EventEmitter.mjs";
import { OpenAIError } from "../../core/error.mjs";
export type ResponsesStreamMessage = {
    type: 'connecting' | 'open' | 'closing' | 'close';
} | {
    type: 'message';
    message: ResponsesAPI.ResponsesServerEvent;
} | {
    type: 'error';
    error: WebSocketError;
};
export declare class WebSocketError extends OpenAIError {
    /**
     * The error data that the API sent back in an error event.
     */
    error?: ResponsesAPI.ResponseErrorEvent | undefined;
    constructor(message: string, event: ResponsesAPI.ResponseErrorEvent | null);
}
type Simplify<T> = {
    [KeyType in keyof T]: T[KeyType];
} & {};
type WebSocketEvents = Simplify<{
    event: (event: ResponsesAPI.ResponsesServerEvent) => void;
    error: (error: WebSocketError) => void;
} & {
    [EventType in Exclude<NonNullable<ResponsesAPI.ResponsesServerEvent['type']>, 'error'>]: (event: Extract<ResponsesAPI.ResponsesServerEvent, {
        type?: EventType;
    }>) => unknown;
}>;
export declare abstract class ResponsesEmitter extends EventEmitter<WebSocketEvents> {
    /**
     * Send an event to the API.
     */
    abstract send(event: ResponsesAPI.ResponsesClientEvent): void;
    /**
     * Close the WebSocket connection.
     */
    abstract close(props?: {
        code: number;
        reason: string;
    }): void;
    protected _onError(event: null, message: string, cause: any): void;
    protected _onError(event: ResponsesAPI.ResponseErrorEvent, message?: string | undefined): void;
}
export declare function buildURL(client: OpenAI, query?: object | null): URL;
export {};
//# sourceMappingURL=internal-base.d.mts.map