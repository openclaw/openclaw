// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import * as ResponsesAPI from './responses';
import { OpenAI } from '../../client';
import { EventEmitter } from '../../core/EventEmitter';
import { OpenAIError } from '../../core/error';
import { stringifyQuery } from '../../internal/utils';

export type ResponsesStreamMessage =
  | { type: 'connecting' | 'open' | 'closing' | 'close' }
  | { type: 'message'; message: ResponsesAPI.ResponsesServerEvent }
  | { type: 'error'; error: WebSocketError };

export class WebSocketError extends OpenAIError {
  /**
   * The error data that the API sent back in an error event.
   */
  error?: ResponsesAPI.ResponseErrorEvent | undefined;

  constructor(message: string, event: ResponsesAPI.ResponseErrorEvent | null) {
    super(message);

    this.error = event ?? undefined;
  }
}

type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};

type WebSocketEvents = Simplify<
  {
    event: (event: ResponsesAPI.ResponsesServerEvent) => void;
    error: (error: WebSocketError) => void;
  } & {
    [EventType in Exclude<NonNullable<ResponsesAPI.ResponsesServerEvent['type']>, 'error'>]: (
      event: Extract<ResponsesAPI.ResponsesServerEvent, { type?: EventType }>,
    ) => unknown;
  }
>;

export abstract class ResponsesEmitter extends EventEmitter<WebSocketEvents> {
  /**
   * Send an event to the API.
   */
  abstract send(event: ResponsesAPI.ResponsesClientEvent): void;

  /**
   * Close the WebSocket connection.
   */
  abstract close(props?: { code: number; reason: string }): void;

  protected _onError(event: null, message: string, cause: any): void;
  protected _onError(event: ResponsesAPI.ResponseErrorEvent, message?: string | undefined): void;
  protected _onError(
    event: ResponsesAPI.ResponseErrorEvent | null,
    message?: string | undefined,
    cause?: any,
  ): void {
    message = message ?? safeJSONStringify(event) ?? 'unknown error';

    if (!this._hasListener('error')) {
      const error = new WebSocketError(
        message +
          `\n\nTo resolve these unhandled rejection errors you should bind an \`error\` callback, e.g. \`ws.on('error', (error) => ...)\` `,
        event,
      );
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

export function buildURL(client: OpenAI, query?: object | null): URL {
  const path = '/responses';
  const baseURL = client.baseURL;
  const url = new URL(baseURL + (baseURL.endsWith('/') ? path.slice(1) : path));
  if (query) {
    url.search = stringifyQuery(query);
  }
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url;
}

function safeJSONStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
