import { getXsXt } from "./signature.js";
import { TlsClient } from "./tls-client.js";
import type { XhsApiResponse } from "./types.js";

const BASE_URL = "https://edith.xiaohongshu.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

export class XhsClient {
  private readonly cookie: string;
  private readonly tls: TlsClient;

  constructor(cookie: string, tls?: TlsClient) {
    this.cookie = cookie;
    this.tls = tls ?? new TlsClient();
  }

  /** Base36 encode a BigInt value. */
  private base36encode(num: bigint): string {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (num === 0n) return "0";
    let result = "";
    let n = num < 0n ? -num : num;
    while (n > 0n) {
      result = alphabet[Number(n % 36n)] + result;
      n = n / 36n;
    }
    return num < 0n ? "-" + result : result;
  }

  /** Generate a search_id for search requests. */
  searchId(): string {
    const e = BigInt(Date.now()) << 64n;
    const t = BigInt(Math.floor(Math.random() * 2147483646));
    return this.base36encode(e + t);
  }

  /**
   * Make an API request to Xiaohongshu.
   * Uses curl_cffi TLS bridge when available, falls back to native fetch.
   * @param signed - If true, compute and attach x-s / x-t signature headers.
   */
  async request<T>(
    uri: string,
    options: {
      method?: "GET" | "POST";
      data?: unknown;
      params?: Record<string, string>;
      signed?: boolean;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<XhsApiResponse<T>> {
    const { method = "GET", data, params, signed = false, extraHeaders } = options;

    let url = `${BASE_URL}${uri}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      "content-type": "application/json;charset=UTF-8",
      "user-agent": USER_AGENT,
      origin: "https://www.xiaohongshu.com",
      referer: "https://www.xiaohongshu.com/",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...extraHeaders,
    };

    if (signed && data !== undefined) {
      const { xs, xt } = getXsXt(uri, data, this.cookie);
      headers["x-s"] = xs;
      headers["x-t"] = String(xt);
    }

    const body = data !== undefined ? JSON.stringify(data) : undefined;

    const res = await this.tls.fetch(url, {
      method,
      headers,
      cookies: this.cookie,
      body,
    });

    return JSON.parse(res.body) as XhsApiResponse<T>;
  }

  /** Shut down the underlying TLS bridge process. */
  async close(): Promise<void> {
    await this.tls.close();
  }

  /** Whether Chrome TLS impersonation is active. */
  get hasTlsBridge(): boolean {
    return this.tls.hasTlsBridge;
  }
}
