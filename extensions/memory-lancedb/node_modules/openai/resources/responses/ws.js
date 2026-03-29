"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponsesWS = void 0;
const tslib_1 = require("../../internal/tslib.js");
const WS = tslib_1.__importStar(require("ws"));
const internal_base_1 = require("./internal-base.js");
class ResponsesWS extends internal_base_1.ResponsesEmitter {
    constructor(client, options) {
        super();
        this.client = client;
        this.url = (0, internal_base_1.buildURL)(client, {});
        this.socket = new WS.WebSocket(this.url, {
            ...options,
            headers: {
                ...this.authHeaders(),
                ...options?.headers,
            },
        });
        this.socket.on('message', (wsEvent) => {
            const event = (() => {
                try {
                    return JSON.parse(wsEvent.toString());
                }
                catch (err) {
                    this._onError(null, 'could not parse websocket event', err);
                    return null;
                }
            })();
            if (event) {
                this._emit('event', event);
                if (event.type === 'error') {
                    this._onError(event);
                }
                else {
                    // @ts-ignore TS isn't smart enough to get the relationship right here
                    this._emit(event.type, event);
                }
            }
        });
        this.socket.on('error', (err) => {
            this._onError(null, err.message, err);
        });
    }
    send(event) {
        try {
            this.socket.send(JSON.stringify(event));
        }
        catch (err) {
            this._onError(null, 'could not send data', err);
        }
    }
    close(props) {
        try {
            this.socket.close(props?.code ?? 1000, props?.reason ?? 'OK');
        }
        catch (err) {
            this._onError(null, 'could not close the connection', err);
        }
    }
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
    stream() {
        return this[Symbol.asyncIterator]();
    }
    [Symbol.asyncIterator]() {
        // Two-queue async iterator: `queue` buffers incoming messages,
        // `resolvers` buffers waiting next() calls. A push wakes the
        // oldest next(); a next() drains the oldest message.
        const queue = [];
        const resolvers = [];
        let done = false;
        const push = (msg) => {
            queue.push(msg);
            resolvers.shift()?.();
        };
        const onEvent = (event) => {
            if (event.type === 'error')
                return; // handled by onEmitterError
            push({ type: 'message', message: event });
        };
        // Catches both API-level and socket-level errors via _onError → _emit('error')
        const onEmitterError = (err) => {
            push({ type: 'error', error: err });
        };
        const onOpen = () => {
            push({ type: 'open' });
        };
        const flushResolvers = () => {
            for (let resolver = resolvers.shift(); resolver; resolver = resolvers.shift()) {
                resolver();
            }
        };
        const onClose = () => {
            push({ type: 'close' });
            done = true;
            flushResolvers();
            cleanup();
        };
        const cleanup = () => {
            this.off('event', onEvent);
            this.off('error', onEmitterError);
            this.socket.off('open', onOpen);
            this.socket.off('close', onClose);
        };
        this.on('event', onEvent);
        this.on('error', onEmitterError);
        this.socket.on('open', onOpen);
        this.socket.on('close', onClose);
        switch (this.socket.readyState) {
            case WS.WebSocket.CONNECTING:
                push({ type: 'connecting' });
                break;
            case WS.WebSocket.OPEN:
                push({ type: 'open' });
                break;
            case WS.WebSocket.CLOSING:
                push({ type: 'closing' });
                break;
            case WS.WebSocket.CLOSED:
                push({ type: 'close' });
                done = true;
                cleanup();
                break;
        }
        const resolve = (res) => {
            if (queue.length > 0) {
                res({ value: queue.shift(), done: false });
            }
            else if (done) {
                res({ value: undefined, done: true });
            }
            else {
                return false;
            }
            return true;
        };
        const next = () => new Promise((res) => {
            if (resolve(res))
                return;
            resolvers.push(() => {
                resolve(res);
            });
        });
        return {
            next,
            return: () => {
                done = true;
                cleanup();
                flushResolvers();
                return Promise.resolve({ value: undefined, done: true });
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
    }
    authHeaders() {
        return { Authorization: `Bearer ${this.client.apiKey}` };
        return {};
    }
}
exports.ResponsesWS = ResponsesWS;
//# sourceMappingURL=ws.js.map