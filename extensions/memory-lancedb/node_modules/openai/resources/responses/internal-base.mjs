// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { EventEmitter } from "../../core/EventEmitter.mjs";
import { OpenAIError } from "../../core/error.mjs";
import { stringifyQuery } from "../../internal/utils.mjs";
export class WebSocketError extends OpenAIError {
    constructor(message, event) {
        super(message);
        this.error = event ?? undefined;
    }
}
export class ResponsesEmitter extends EventEmitter {
    _onError(event, message, cause) {
        message = message ?? safeJSONStringify(event) ?? 'unknown error';
        if (!this._hasListener('error')) {
            const error = new WebSocketError(message +
                `\n\nTo resolve these unhandled rejection errors you should bind an \`error\` callback, e.g. \`ws.on('error', (error) => ...)\` `, event);
            // @ts-ignore
            error.cause = cause;
            Promise.reject(error);
            return;
        }
        const error = new WebSocketError(message, event);
        // @ts-ignore
        error.cause = cause;
        this._emit('error', error);
    }
}
export function buildURL(client, query) {
    const path = '/responses';
    const baseURL = client.baseURL;
    const url = new URL(baseURL + (baseURL.endsWith('/') ? path.slice(1) : path));
    if (query) {
        url.search = stringifyQuery(query);
    }
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return url;
}
function safeJSONStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=internal-base.mjs.map