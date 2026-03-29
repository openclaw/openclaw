"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponsesEmitter = exports.WebSocketError = void 0;
exports.buildURL = buildURL;
const EventEmitter_1 = require("../../core/EventEmitter.js");
const error_1 = require("../../core/error.js");
const utils_1 = require("../../internal/utils.js");
class WebSocketError extends error_1.OpenAIError {
    constructor(message, event) {
        super(message);
        this.error = event ?? undefined;
    }
}
exports.WebSocketError = WebSocketError;
class ResponsesEmitter extends EventEmitter_1.EventEmitter {
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
exports.ResponsesEmitter = ResponsesEmitter;
function buildURL(client, query) {
    const path = '/responses';
    const baseURL = client.baseURL;
    const url = new URL(baseURL + (baseURL.endsWith('/') ? path.slice(1) : path));
    if (query) {
        url.search = (0, utils_1.stringifyQuery)(query);
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
//# sourceMappingURL=internal-base.js.map