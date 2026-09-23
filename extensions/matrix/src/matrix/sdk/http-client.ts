import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { buildHttpError } from "./event-helpers.js";
import { type HttpMethod, type QueryParams, performMatrixRequest } from "./transport.js";

type MatrixAuthedHttpClientParams = {
  homeserver: string;
  accessToken: string;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  captureRequestAuthority?: () => (() => void) | undefined;
  captureSendCurrentness?: () => (() => void) | undefined;
  signal?: AbortSignal;
};

export class MatrixAuthedHttpClient {
  private readonly homeserver: string;
  private readonly accessToken: string;
  private readonly ssrfPolicy?: SsrFPolicy;
  private readonly dispatcherPolicy?: PinnedDispatcherPolicy;
  private readonly captureRequestAuthority?: () => (() => void) | undefined;
  private readonly captureSendCurrentness?: () => (() => void) | undefined;
  private readonly signal?: AbortSignal;

  constructor(params: MatrixAuthedHttpClientParams) {
    this.homeserver = params.homeserver;
    this.accessToken = params.accessToken;
    this.ssrfPolicy = params.ssrfPolicy;
    this.dispatcherPolicy = params.dispatcherPolicy;
    this.captureRequestAuthority = params.captureRequestAuthority;
    this.captureSendCurrentness = params.captureSendCurrentness;
    this.signal = params.signal;
  }

  async requestJson(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    body?: unknown;
    timeoutMs: number;
    allowAbsoluteEndpoint?: boolean;
  }): Promise<unknown> {
    const { response, text } = await performMatrixRequest({
      homeserver: this.homeserver,
      accessToken: this.accessToken,
      method: params.method,
      endpoint: params.endpoint,
      qs: params.qs,
      body: params.body,
      timeoutMs: params.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
      dispatcherPolicy: this.dispatcherPolicy,
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
      assertCurrent: this.captureRequestAuthority?.(),
      assertSendCurrent: this.captureSendCurrentness?.(),
      signal: this.signal,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, text);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType === "application/json") {
      if (!text.trim()) {
        return {};
      }
      try {
        return JSON.parse(text);
      } catch {
        throw Object.assign(new Error("Matrix homeserver returned malformed JSON"), {
          statusCode: response.status,
        });
      }
    }
    return text;
  }

  async requestRaw(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    timeoutMs: number;
    maxBytes?: number;
    readIdleTimeoutMs?: number;
    allowAbsoluteEndpoint?: boolean;
  }): Promise<Buffer> {
    const { response, buffer } = await performMatrixRequest({
      homeserver: this.homeserver,
      accessToken: this.accessToken,
      method: params.method,
      endpoint: params.endpoint,
      qs: params.qs,
      timeoutMs: params.timeoutMs,
      raw: true,
      maxBytes: params.maxBytes,
      readIdleTimeoutMs: params.readIdleTimeoutMs,
      ssrfPolicy: this.ssrfPolicy,
      dispatcherPolicy: this.dispatcherPolicy,
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
      assertCurrent: this.captureRequestAuthority?.(),
      assertSendCurrent: this.captureSendCurrentness?.(),
      signal: this.signal,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, buffer.toString("utf8"));
    }
    return buffer;
  }
}
