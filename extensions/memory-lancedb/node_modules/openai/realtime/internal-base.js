"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIRealtimeEmitter = exports.OpenAIRealtimeError = void 0;
exports.isAzure = isAzure;
exports.buildRealtimeURL = buildRealtimeURL;
const EventEmitter_1 = require("../lib/EventEmitter.js");
const error_1 = require("../error.js");
const index_1 = require("../index.js");
class OpenAIRealtimeError extends error_1.OpenAIError {
    constructor(message, event) {
        super(message);
        this.error = event?.error;
        this.event_id = event?.event_id;
    }
}
exports.OpenAIRealtimeError = OpenAIRealtimeError;
class OpenAIRealtimeEmitter extends EventEmitter_1.EventEmitter {
    _onError(event, message, cause) {
        message =
            event?.error ?
                `${event.error.message} code=${event.error.code} param=${event.error.param} type=${event.error.type} event_id=${event.error.event_id}`
                : message ?? 'unknown error';
        if (!this._hasListener('error')) {
            const error = new OpenAIRealtimeError(message +
                `\n\nTo resolve these unhandled rejection errors you should bind an \`error\` callback, e.g. \`rt.on('error', (error) => ...)\` `, event);
            // @ts-ignore
            error.cause = cause;
            Promise.reject(error);
            return;
        }
        const error = new OpenAIRealtimeError(message, event);
        // @ts-ignore
        error.cause = cause;
        this._emit('error', error);
    }
}
exports.OpenAIRealtimeEmitter = OpenAIRealtimeEmitter;
function isAzure(client) {
    return client instanceof index_1.AzureOpenAI;
}
function buildRealtimeURL(client, model) {
    const path = '/realtime';
    const baseURL = client.baseURL;
    const url = new URL(baseURL + (baseURL.endsWith('/') ? path.slice(1) : path));
    url.protocol = 'wss';
    if (isAzure(client)) {
        url.searchParams.set('api-version', client.apiVersion);
        url.searchParams.set('deployment', model);
    }
    else {
        url.searchParams.set('model', model);
    }
    return url;
}
//# sourceMappingURL=internal-base.js.map