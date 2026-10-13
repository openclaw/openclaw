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

type MatrixHttpRequestParams = {
  method: HttpMethod;
  endpoint: string;
  qs?: QueryParams;
  body?: unknown;
  timeoutMs: number;
  allowAbsoluteEndpoint?: boolean;
  raw?: boolean;
  maxBytes?: number;
  readIdleTimeoutMs?: number;
};

export class MatrixAuthedHttpClient {
  private readonly params: MatrixAuthedHttpClientParams;

  constructor(params: MatrixAuthedHttpClientParams) {
    this.params = { ...params };
  }

  private async request(params: MatrixHttpRequestParams) {
    const { captureRequestAuthority, captureSendCurrentness, ...auth } = this.params;
    const result = await performMatrixRequest({
      ...params,
      ...auth,
      assertCurrent: captureRequestAuthority?.call(this),
      assertSendCurrent: captureSendCurrentness?.call(this),
    });
    if (!result.response.ok) {
      throw buildHttpError(result.response.status, result.text);
    }
    return result;
  }

  async requestJson(
    params: Omit<MatrixHttpRequestParams, "raw" | "maxBytes" | "readIdleTimeoutMs">,
  ): Promise<unknown> {
    const { response, text } = await this.request(params);
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

  async requestRaw(params: Omit<MatrixHttpRequestParams, "raw" | "body">): Promise<Buffer> {
    const { buffer } = await this.request({ ...params, raw: true });
    return buffer;
  }
}
