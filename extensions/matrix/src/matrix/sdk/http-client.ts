import { buildHttpError } from "./event-helpers.js";
import { type HttpMethod, type QueryParams, performMatrixRequest } from "./transport.js";

export class MatrixAuthedHttpClient {
  constructor(
    private readonly homeserver: string,
    private readonly accessToken: string,
  ) {}

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
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, text);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      if (!text.trim()) {
        return {};
      }
      return JSON.parse(text);
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
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, buffer.toString("utf8"));
    }
    return buffer;
  }
}
