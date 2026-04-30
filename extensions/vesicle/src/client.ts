import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
import {
  fetchWithSsrFGuard,
  isBlockedHostnameOrIp,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveVesicleServerAccount } from "./accounts.js";
import type { VesicleCapabilities, VesicleHealthResponse } from "./types.js";
import { normalizeVesicleServerUrl } from "./url.js";

const DEFAULT_TIMEOUT_MS = 10_000;

function safeExtractHostname(baseUrl: string): string | undefined {
  try {
    const hostname = new URL(normalizeVesicleServerUrl(baseUrl)).hostname.trim();
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

export function resolveVesicleClientSsrfPolicy(params: {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  allowPrivateNetworkConfig?: boolean;
}): {
  ssrfPolicy: SsrFPolicy;
  trustedHostname?: string;
  trustedHostnameIsPrivate: boolean;
} {
  const trustedHostname = safeExtractHostname(params.baseUrl);
  const trustedHostnameIsPrivate = trustedHostname ? isBlockedHostnameOrIp(trustedHostname) : false;

  if (params.allowPrivateNetwork) {
    return {
      ssrfPolicy: { allowPrivateNetwork: true },
      trustedHostname,
      trustedHostnameIsPrivate,
    };
  }

  if (
    trustedHostname &&
    (params.allowPrivateNetworkConfig !== false || !trustedHostnameIsPrivate)
  ) {
    return {
      ssrfPolicy: { allowedHostnames: [trustedHostname] },
      trustedHostname,
      trustedHostnameIsPrivate,
    };
  }

  return { ssrfPolicy: {}, trustedHostname, trustedHostnameIsPrivate };
}

async function vesicleFetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  ssrfPolicy: SsrFPolicy,
): Promise<Response> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init,
    timeoutMs,
    policy: ssrfPolicy,
    auditContext: "vesicle-api",
  });
  const isNullBody =
    response.status === 101 ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  try {
    const bodyBytes = isNullBody ? null : await response.arrayBuffer();
    return new Response(bodyBytes, { status: response.status, headers: response.headers });
  } finally {
    await release();
  }
}

export type VesicleClientOptions = {
  cfg?: OpenClawConfig;
  accountId?: string | null;
  serverUrl?: string | null;
  authToken?: string | null;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
};

type VesicleClientConstructorParams = {
  accountId: string;
  baseUrl: string;
  authToken: string;
  defaultTimeoutMs: number;
  ssrfPolicy: SsrFPolicy;
  trustedHostname?: string;
  trustedHostnameIsPrivate: boolean;
};

export class VesicleClient {
  readonly accountId: string;
  readonly baseUrl: string;
  readonly trustedHostname: string | undefined;
  readonly trustedHostnameIsPrivate: boolean;

  private readonly authToken: string;
  private readonly defaultTimeoutMs: number;
  private readonly ssrfPolicy: SsrFPolicy;

  constructor(params: VesicleClientConstructorParams) {
    this.accountId = params.accountId;
    this.baseUrl = params.baseUrl;
    this.authToken = params.authToken;
    this.defaultTimeoutMs = params.defaultTimeoutMs;
    this.ssrfPolicy = params.ssrfPolicy;
    this.trustedHostname = params.trustedHostname;
    this.trustedHostnameIsPrivate = params.trustedHostnameIsPrivate;
  }

  getSsrfPolicy(): SsrFPolicy {
    return this.ssrfPolicy;
  }

  private buildRequest(params: { path: string; method: string; init?: RequestInit }): {
    url: string;
    init: RequestInit;
  } {
    const normalized = normalizeVesicleServerUrl(this.baseUrl);
    const url = new URL(params.path, `${normalized}/`);
    const headers = new Headers(params.init?.headers ?? undefined);
    headers.set("Authorization", `Bearer ${this.authToken}`);
    return {
      url: url.toString(),
      init: {
        ...params.init,
        method: params.method,
        headers,
      },
    };
  }

  async request(params: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<Response> {
    const init: RequestInit = {};
    if (params.headers) {
      init.headers = { ...params.headers };
    }
    if (params.body !== undefined) {
      init.headers = {
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      };
      init.body = JSON.stringify(params.body);
    }
    const prepared = this.buildRequest({
      path: params.path,
      method: params.method,
      init,
    });
    return await vesicleFetchWithTimeout(
      prepared.url,
      prepared.init,
      params.timeoutMs ?? this.defaultTimeoutMs,
      this.ssrfPolicy,
    );
  }

  async requestJson(params: {
    method: string;
    path: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<{ response: Response; data: unknown }> {
    const response = await this.request(params);
    const data: unknown = await response.json().catch(() => null);
    return { response, data };
  }

  async health(params: { timeoutMs?: number } = {}): Promise<{
    response: Response;
    data: VesicleHealthResponse | null;
  }> {
    const { response, data } = await this.requestJson({
      method: "GET",
      path: "/api/v1/vesicle/health",
      timeoutMs: params.timeoutMs,
    });
    return {
      response,
      data: typeof data === "object" && data !== null ? (data as VesicleHealthResponse) : null,
    };
  }

  async capabilities(params: { timeoutMs?: number } = {}): Promise<{
    response: Response;
    data: VesicleCapabilities | null;
  }> {
    const { response, data } = await this.requestJson({
      method: "GET",
      path: "/api/v1/vesicle/capabilities",
      timeoutMs: params.timeoutMs,
    });
    return {
      response,
      data: typeof data === "object" && data !== null ? (data as VesicleCapabilities) : null,
    };
  }

  async sendText(params: {
    chatGuid: string;
    text: string;
    timeoutMs?: number;
  }): Promise<{ response: Response; data: unknown }> {
    return await this.requestJson({
      method: "POST",
      path: "/api/v1/vesicle/message/text",
      body: {
        chatGuid: params.chatGuid,
        text: params.text,
      },
      timeoutMs: params.timeoutMs,
    });
  }
}

export function createVesicleClientFromParts(params: {
  baseUrl: string;
  authToken: string;
  accountId?: string;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
  allowPrivateNetworkConfig?: boolean;
}): VesicleClient {
  const policyResult = resolveVesicleClientSsrfPolicy({
    baseUrl: params.baseUrl,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    allowPrivateNetworkConfig: params.allowPrivateNetworkConfig,
  });
  return new VesicleClient({
    accountId: params.accountId ?? "default",
    baseUrl: normalizeVesicleServerUrl(params.baseUrl),
    authToken: params.authToken,
    defaultTimeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ssrfPolicy: policyResult.ssrfPolicy,
    trustedHostname: policyResult.trustedHostname,
    trustedHostnameIsPrivate: policyResult.trustedHostnameIsPrivate,
  });
}

export function createVesicleClient(opts: VesicleClientOptions = {}): VesicleClient {
  const resolved = resolveVesicleServerAccount({
    cfg: opts.cfg,
    accountId: opts.accountId,
    serverUrl: opts.serverUrl,
    authToken: opts.authToken,
    allowPrivateNetwork: opts.allowPrivateNetwork,
  });
  return createVesicleClientFromParts({
    accountId: resolved.accountId,
    baseUrl: resolved.baseUrl,
    authToken: resolved.authToken,
    timeoutMs: opts.timeoutMs,
    allowPrivateNetwork: resolved.allowPrivateNetwork,
    allowPrivateNetworkConfig: resolved.allowPrivateNetworkConfig,
  });
}

export async function unguardedVesicleFetchForTests(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchWithRuntimeDispatcherOrMockedGlobal(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
