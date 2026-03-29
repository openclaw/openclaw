// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import type { FinalRequestOptions } from './request-options';
import { Stream } from '../core/streaming';
import { type OpenAI } from '../client';
import { formatRequestDetails, loggerFor } from './utils/log';
import type { AbstractPage } from '../pagination';

export type APIResponseProps = {
  response: Response;
  options: FinalRequestOptions;
  controller: AbortController;
  requestLogID: string;
  retryOfRequestLogID: string | undefined;
  startTime: number;
};

export async function defaultParseResponse<T>(
  client: OpenAI,
  props: APIResponseProps,
): Promise<WithRequestID<T>> {
  const { response, requestLogID, retryOfRequestLogID, startTime } = props;
  const body = await (async () => {
    if (props.options.stream) {
      loggerFor(client).debug('response', response.status, response.url, response.headers, response.body);

      // Note: there is an invariant here that isn't represented in the type system
      // that if you set `stream: true` the response type must also be `Stream<T>`

      if (props.options.__streamClass) {
        return props.options.__streamClass.fromSSEResponse(
          response,
          props.controller,
          client,
          props.options.__synthesizeEventData,
        ) as any;
      }

      return Stream.fromSSEResponse(
        response,
        props.controller,
        client,
        props.options.__synthesizeEventData,
      ) as any;
    }

    // fetch refuses to read the body when the status code is 204.
    if (response.status === 204) {
      return null as T;
    }

    if (props.options.__binaryResponse) {
      return response as unknown as T;
    }

    const contentType = response.headers.get('content-type');
    const mediaType = contentType?.split(';')[0]?.trim();
    const isJSON = mediaType?.includes('application/json') || mediaType?.endsWith('+json');
    if (isJSON) {
      const contentLength = response.headers.get('content-length');
      if (contentLength === '0') {
        // if there is no content we can't do anything
        return undefined as T;
      }

      const json = await response.json();
      return addRequestID(json as T, response);
    }

    const text = await response.text();
    return text as unknown as T;
  })();
  loggerFor(client).debug(
    `[${requestLogID}] response parsed`,
    formatRequestDetails({
      retryOfRequestLogID,
      url: response.url,
      status: response.status,
      body,
      durationMs: Date.now() - startTime,
    }),
  );
  return body;
}

export type WithRequestID<T> =
  T extends Array<any> | Response | AbstractPage<any> ? T
  : T extends Record<string, any> ? T & { _request_id?: string | null }
  : T;

export function addRequestID<T>(value: T, response: Response): WithRequestID<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value as WithRequestID<T>;
  }

  return Object.defineProperty(value, '_request_id', {
    value: response.headers.get('x-request-id'),
    enumerable: false,
  }) as WithRequestID<T>;
}
