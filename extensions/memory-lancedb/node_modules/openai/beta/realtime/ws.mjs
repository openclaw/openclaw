import * as WS from 'ws';
import { OpenAI } from "../../index.mjs";
import { OpenAIRealtimeEmitter, buildRealtimeURL, isAzure } from "./internal-base.mjs";
export class OpenAIRealtimeWS extends OpenAIRealtimeEmitter {
    constructor(props, client) {
        super();
        client ?? (client = new OpenAI());
        const hasProvider = typeof client?._options?.apiKey === 'function';
        if (hasProvider && !props.__resolvedApiKey) {
            throw new Error([
                'Cannot open Realtime WebSocket with a function-based apiKey.',
                'Use the .create() method so that the key is resolved before connecting:',
                'await OpenAIRealtimeWS.create(client, { model })',
            ].join('\n'));
        }
        this.url = buildRealtimeURL(client, props.model);
        this.socket = new WS.WebSocket(this.url, {
            ...props.options,
            headers: {
                ...props.options?.headers,
                ...(isAzure(client) && !props.__resolvedApiKey ? {} : { Authorization: `Bearer ${client.apiKey}` }),
                'OpenAI-Beta': 'realtime=v1',
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
                    // @ts-expect-error TS isn't smart enough to get the relationship right here
                    this._emit(event.type, event);
                }
            }
        });
        this.socket.on('error', (err) => {
            this._onError(null, err.message, err);
        });
    }
    static async create(client, props) {
        return new OpenAIRealtimeWS({ ...props, __resolvedApiKey: await client._callApiKey() }, client);
    }
    static async azure(client, props = {}) {
        const isApiKeyProvider = await client._callApiKey();
        const deploymentName = props.deploymentName ?? client.deploymentName;
        if (!deploymentName) {
            throw new Error('No deployment name provided');
        }
        return new OpenAIRealtimeWS({
            model: deploymentName,
            options: {
                ...props.options,
                headers: {
                    ...props.options?.headers,
                    ...(isApiKeyProvider ? {} : { 'api-key': client.apiKey }),
                },
            },
            __resolvedApiKey: isApiKeyProvider,
        }, client);
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
}
//# sourceMappingURL=ws.mjs.map